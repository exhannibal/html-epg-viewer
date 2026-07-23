/**
 * Humax / HA enhancements for html-epg-viewer:
 * - live search in sidebar + timeline navbar
 * - rebuilds timeline with only matching channels + programmes
 * - date/time jump navigation
 */
(function (global) {
  'use strict';

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toLocalDateValue(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function toLocalTimeValue(d) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function parseLocalDateTime(dateStr, timeStr) {
    if (!dateStr) return null;
    var t = timeStr && timeStr.length ? timeStr : '00:00';
    var parts = t.split(':');
    var d = new Date(dateStr + 'T00:00:00');
    d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
    return d;
  }

  function channelNameMatches(channel, q) {
    return (channel.channelName || '').toLowerCase().includes(q);
  }

  function programMatches(p, q) {
    if (!q) return false;
    return (
      (p.title || '').toLowerCase().includes(q) ||
      (p.desc || '').toLowerCase().includes(q)
    );
  }

  function buildFilteredChannels(all, q) {
    if (!q) {
      return all.slice();
    }
    var out = [];
    all.forEach(function (ch) {
      var nameHit = channelNameMatches(ch, q);
      var fullList = ch.programList || [];
      var progHits = fullList.filter(function (p) {
        return programMatches(p, q);
      });
      if (!nameHit && !progHits.length) return;
      out.push({
        tvgId: ch.tvgId,
        channelName: ch.channelName,
        tvgLogo: ch.tvgLogo,
        // Name-only match → keep full schedule; otherwise only matching programmes
        programList: nameHit && !progHits.length ? fullList.slice() : progHits.length ? progHits : fullList.slice(),
        _filterMode: nameHit && progHits.length ? 'both' : nameHit ? 'channel' : 'programmes',
      });
    });
    // Prefer programme-filtered list when there are title hits even if name also hits
    out.forEach(function (ch, idx) {
      var original = all.find(function (c) {
        return c.tvgId === ch.tvgId;
      });
      if (!original) return;
      var nameHit = channelNameMatches(original, q);
      var progHits = (original.programList || []).filter(function (p) {
        return programMatches(p, q);
      });
      if (progHits.length) {
        out[idx].programList = progHits;
      } else if (nameHit) {
        out[idx].programList = (original.programList || []).slice();
      }
    });
    return out;
  }

  function HumaxEpgUi(opts) {
    this.xmlepg = opts.xmlepg;
    this.epgContainer = opts.epgContainer;
    this.overlay = opts.overlay;
    this.videoList = opts.videoList;
    this.searchInput = opts.searchInput;
    this.getChannels = opts.getChannels;
    this._lastQuery = '';
    this._debounce = null;
    this._bar = null;
    this._bounds = null;
    this._rebuildTimer = null;
    this._viewChannels = null;
  }

  HumaxEpgUi.prototype._bindSearchInput = function (el) {
    if (!el) return;
    var self = this;
    el.addEventListener('input', function () {
      clearTimeout(self._debounce);
      self._debounce = setTimeout(function () {
        self.applySearch(el.value);
      }, 150);
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        el.value = '';
        self.applySearch('');
      }
    });
  };

  HumaxEpgUi.prototype.install = function () {
    if (this.searchInput) {
      this.searchInput.placeholder = 'Search programmes & channels…';
      this._bindSearchInput(this.searchInput);
    }
  };

  HumaxEpgUi.prototype.captureBounds = function () {
    var x = this.xmlepg;
    if (!x || !x.earliestStartDate) return;
    this._bounds = {
      earliestStartDate: x.earliestStartDate,
      latestStopDate: x.latestStopDate,
      timelineLength: x.timelineLength,
    };
  };

  HumaxEpgUi.prototype.ensureNavBar = function () {
    var thead = this.epgContainer && this.epgContainer.querySelector('.thead');
    if (!thead) return;

    var created = false;
    var bar = this._bar;
    if (!bar || !bar.id) {
      bar = document.createElement('div');
      bar.id = 'epg-nav-bar';
      bar.innerHTML =
        '<div class="epg-nav-group epg-nav-search">' +
        '<input type="search" id="epg-nav-search" placeholder="Search programmes &amp; channels…" autocomplete="off">' +
        '<button type="button" data-nav="clear-search" title="Clear search">Clear</button>' +
        '<span id="epg-nav-search-status"></span>' +
        '</div>' +
        '<div class="epg-nav-group">' +
        '<button type="button" data-nav="day-1" title="Previous day">◀ Day</button>' +
        '<input type="date" id="epg-nav-date" aria-label="Date">' +
        '<button type="button" data-nav="day+1" title="Next day">Day ▶</button>' +
        '</div>' +
        '<div class="epg-nav-group">' +
        '<button type="button" data-nav="h-3" title="Back 3 hours">−3h</button>' +
        '<button type="button" data-nav="h-1" title="Back 1 hour">−1h</button>' +
        '<input type="time" id="epg-nav-time" aria-label="Time">' +
        '<button type="button" data-nav="go" title="Jump to date/time">Go</button>' +
        '<button type="button" data-nav="now" title="Jump to now">Now</button>' +
        '<button type="button" data-nav="h+1" title="Forward 1 hour">+1h</button>' +
        '<button type="button" data-nav="h+3" title="Forward 3 hours">+3h</button>' +
        '</div>';
      this._bar = bar;
      created = true;
    }

    // Sit as the first row inside .thead, above Day/Time
    if (bar.parentNode !== thead || thead.firstElementChild !== bar) {
      thead.insertBefore(bar, thead.firstChild);
    }

    if (created) {
      this._syncNavInputs(new Date());
      this._bindSearchInput(bar.querySelector('#epg-nav-search'));
      var self = this;
      bar.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-nav]');
        if (!btn) return;
        var action = btn.getAttribute('data-nav');
        if (action === 'clear-search') {
          self.applySearch('');
          return;
        }
        self._handleNav(action);
      });
      bar.querySelector('#epg-nav-date').addEventListener('change', function () {
        self._handleNav('go');
      });
      bar.querySelector('#epg-nav-time').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') self._handleNav('go');
      });
      if (!this._navResizeBound) {
        this._navResizeBound = true;
        var syncW = function () {
          self._syncNavWidth();
        };
        window.addEventListener('resize', syncW);
        this.epgContainer.addEventListener('scroll', syncW, { passive: true });
      }
    }

    this._syncSearchInputs(this._lastQuery);
    this._syncNavWidth();
    this.showNavBar();
  };

  HumaxEpgUi.prototype._syncNavWidth = function () {
    if (!this._bar || !this.epgContainer) return;
    this._bar.style.width = this.epgContainer.clientWidth + 'px';
  };

  HumaxEpgUi.prototype._syncSearchInputs = function (raw) {
    var val = raw == null ? '' : String(raw).trim();
    if (this.searchInput && this.searchInput.value !== val) {
      this.searchInput.value = val;
    }
    var navSearch = document.getElementById('epg-nav-search');
    if (navSearch && navSearch.value !== val) {
      navSearch.value = val;
    }
  };

  HumaxEpgUi.prototype.showNavBar = function () {
    if (this._bar) this._bar.classList.add('epg-nav-visible');
  };

  HumaxEpgUi.prototype.hideNavBar = function () {
    if (this._bar) this._bar.classList.remove('epg-nav-visible');
  };

  HumaxEpgUi.prototype._syncNavInputs = function (d) {
    var dateEl = document.getElementById('epg-nav-date');
    var timeEl = document.getElementById('epg-nav-time');
    if (dateEl) dateEl.value = toLocalDateValue(d);
    if (timeEl) timeEl.value = toLocalTimeValue(d);
  };

  HumaxEpgUi.prototype._readNavDateTime = function () {
    var dateEl = document.getElementById('epg-nav-date');
    var timeEl = document.getElementById('epg-nav-time');
    return parseLocalDateTime(
      dateEl ? dateEl.value : '',
      timeEl ? timeEl.value : '00:00'
    );
  };

  HumaxEpgUi.prototype._handleNav = function (action) {
    var base = this._readNavDateTime() || new Date();
    var d = new Date(base.getTime());
    if (action === 'now') {
      d = new Date();
    } else if (action === 'day-1') {
      d.setDate(d.getDate() - 1);
    } else if (action === 'day+1') {
      d.setDate(d.getDate() + 1);
    } else if (action === 'h-3') {
      d.setHours(d.getHours() - 3);
    } else if (action === 'h-1') {
      d.setHours(d.getHours() - 1);
    } else if (action === 'h+1') {
      d.setHours(d.getHours() + 1);
    } else if (action === 'h+3') {
      d.setHours(d.getHours() + 3);
    }
    this._syncNavInputs(d);
    this.scrollToDateTime(d);
  };

  HumaxEpgUi.prototype.scrollToDateTime = function (date) {
    var x = this.xmlepg;
    if (!x || !x.earliestStartDate || !this.epgContainer) return;
    var mins = x.getMinutesSinceEarliestStartDate(x.earliestStartDate, date);
    var channelCol = 200;
    var px = channelCol + mins * x.oneUnit;
    var target = Math.max(0, px - Math.floor(this.epgContainer.clientWidth * 0.25));
    this.epgContainer.scrollTo({ left: target, behavior: 'smooth' });
  };

  HumaxEpgUi.prototype.annotateTimeline = function () {
    var channels = this._viewChannels || this.getChannels() || [];
    var rows = this.epgContainer.querySelectorAll('.table > .row');
    for (var i = 0; i < rows.length && i < channels.length; i++) {
      var ch = channels[i];
      var row = rows[i];
      row.dataset.tvgId = ch.tvgId || '';
      row.dataset.channelName = ch.channelName || '';
      var cells = row.querySelectorAll('.cell:not(.pinned-channel-box)');
      var progIdx = 0;
      var list = ch.programList || [];
      cells.forEach(function (cell) {
        if (!cell.querySelector('.program-title')) return;
        var prog = list[progIdx++];
        if (!prog) return;
        cell.classList.add('program-cell');
        if (prog._searchHit) cell.classList.add('search-hit');
        cell.dataset.title = prog.title || '';
        cell.dataset.desc = prog.desc || '';
        cell.dataset.startMs = String(prog.startDate.getTime());
      });
    }
  };

  HumaxEpgUi.prototype.renderPlaylist = function (list) {
    var self = this;
    if (!this.videoList) return;
    this.videoList.innerHTML = '';
    list.forEach(function (channel) {
      var li = document.createElement('li');
      li.dataset.tvgId = channel.tvgId || '';
      var logo = channel.tvgLogo || '';
      li.innerHTML =
        (logo ? '<img src="' + logo + '" alt="">' : '') +
        '<span class="video-title">' +
        channel.channelName +
        '</span>';
      li.addEventListener('click', function () {
        self.openChannelDetail(channel);
        var kids = self.videoList.getElementsByTagName('li');
        for (var i = 0; i < kids.length; i++) kids[i].classList.remove('active');
        li.classList.add('active');
      });
      self.videoList.appendChild(li);
    });
  };

  HumaxEpgUi.prototype.openChannelDetail = function (channel) {
    // Use currently filtered channel object (already has filtered programList)
    var q = this._lastQuery;
    var list = channel.programList || [];
    this.epgContainer.style.display = 'none';
    this.hideNavBar();
    if (this.overlay) this.overlay.style.display = 'flex';
    var oldNote = document.getElementById('overlay-search-note');
    if (oldNote) oldNote.remove();

    // displayPrograms looks up by tvgId on xmlepg.channels — keep view channels mounted
    this.xmlepg.displayPrograms('overlay', channel.tvgId);

    if (q && list.length && this.overlay) {
      var note = document.createElement('div');
      note.id = 'overlay-search-note';
      note.textContent =
        'Showing ' +
        list.length +
        ' programme' +
        (list.length === 1 ? '' : 's') +
        (q ? ' for “' + q + '”' : '') +
        ' · Clear search for full schedule';
      this.overlay.insertBefore(note, this.overlay.firstChild);
    }
  };

  HumaxEpgUi.prototype._markHits = function (channels, q) {
    if (!q) return channels;
    channels.forEach(function (ch) {
      (ch.programList || []).forEach(function (p) {
        p._searchHit = programMatches(p, q);
      });
    });
    return channels;
  };

  HumaxEpgUi.prototype.rebuildTimeline = async function (channels) {
    var x = this.xmlepg;
    if (!x) return;
    if (!this._bounds) this.captureBounds();
    var bounds = this._bounds;
    this._viewChannels = channels;
    x.channels = channels;
    if (bounds) {
      x.earliestStartDate = bounds.earliestStartDate;
      x.latestStopDate = bounds.latestStopDate;
      x.timelineLength = bounds.timelineLength;
    }
    await x.displayAllPrograms('epg-container', 'xmlepg');
    this.annotateTimeline();
    this.ensureNavBar();
    if (this.epgContainer.style.display !== 'none') {
      x.clearTimelineNeedle && x.clearTimelineNeedle();
      x.timelineNeedleRender();
    }
  };

  HumaxEpgUi.prototype.applySearch = function (raw) {
    var self = this;
    var q = (raw || '').trim().toLowerCase();
    this._lastQuery = q;
    this._syncSearchInputs(raw == null ? '' : String(raw).trim());

    var all = this.getChannels() || [];
    var filtered = buildFilteredChannels(all, q);
    this._markHits(filtered, q);

    // Sidebar + timeline share the same filtered set
    this.renderPlaylist(filtered);

    var progCount = 0;
    filtered.forEach(function (ch) {
      progCount += (ch.programList || []).length;
    });
    var statusText = '';
    if (q) {
      statusText =
        filtered.length +
        ' ch · ' +
        progCount +
        ' prog' +
        (progCount === 1 ? '' : 's');
    }
    var status = document.getElementById('search-status');
    if (status) status.textContent = statusText;
    var navStatus = document.getElementById('epg-nav-search-status');
    if (navStatus) navStatus.textContent = statusText;

    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(function () {
      self.rebuildTimeline(filtered).then(function () {
        if (!q) return;
        var first = null;
        filtered.some(function (ch) {
          return (ch.programList || []).some(function (p) {
            if (p._searchHit || programMatches(p, q)) {
              first = p.startDate;
              return true;
            }
            return false;
          });
        });
        if (first) {
          self.scrollToDateTime(first);
          self._syncNavInputs(first);
        }
      });
    }, 80);
  };

  HumaxEpgUi.prototype.onTimelineOpened = function () {
    this.captureBounds();
    this.ensureNavBar();
    if (this._lastQuery) {
      this.applySearch(this._lastQuery);
    } else {
      this._viewChannels = this.getChannels() || [];
      this.xmlepg.channels = this._viewChannels;
      this.annotateTimeline();
      this._syncNavInputs(new Date());
      this.renderPlaylist(this._viewChannels);
    }
  };

  global.HumaxEpgUi = HumaxEpgUi;
})(window);
