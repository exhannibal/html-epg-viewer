/**
 * Humax / HA enhancements for html-epg-viewer:
 * - live search (sidebar + navbar) without stealing focus on refresh
 * - rebuilds timeline with matching channels + programmes
 * - hit heatmap row + previous/next navigation
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
    if (!q) return all.slice();
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
        programList: progHits.length ? progHits.slice() : fullList.slice(),
      });
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
    this._appliedQuery = null;
    this._debounce = null;
    this._bar = null;
    this._hitRail = null;
    this._bounds = null;
    this._rebuildTimer = null;
    this._viewChannels = null;
    this._hits = [];
    this._hitIndex = -1;
    this._navResizeBound = false;
    this._barWired = false;
    this._hitWired = false;
  }

  HumaxEpgUi.prototype._bindSearchInput = function (el) {
    if (!el || el.dataset.humaxBound) return;
    el.dataset.humaxBound = '1';
    var self = this;
    el.addEventListener('input', function () {
      clearTimeout(self._debounce);
      self._debounce = setTimeout(function () {
        self.applySearch(el.value);
      }, 220);
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        el.value = '';
        self.applySearch('');
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) self.goToHit(self._hitIndex - 1);
        else self.goToHit(self._hitIndex + 1);
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

  HumaxEpgUi.prototype._captureSearchFocus = function () {
    var a = document.activeElement;
    if (!a) return null;
    if (a.id === 'epg-nav-search') {
      return {
        which: 'nav',
        start: a.selectionStart,
        end: a.selectionEnd,
        value: a.value,
      };
    }
    if (this.searchInput && a === this.searchInput) {
      return {
        which: 'side',
        start: a.selectionStart,
        end: a.selectionEnd,
        value: a.value,
      };
    }
    return null;
  };

  HumaxEpgUi.prototype._restoreSearchFocus = function (state) {
    if (!state) return;
    var self = this;
    requestAnimationFrame(function () {
      var el =
        state.which === 'nav'
          ? document.getElementById('epg-nav-search')
          : self.searchInput;
      if (!el) return;
      el.focus();
      try {
        var len = el.value.length;
        var s = Math.min(state.start == null ? len : state.start, len);
        var e = Math.min(state.end == null ? len : state.end, len);
        el.setSelectionRange(s, e);
      } catch (err) {
        /* ignore */
      }
    });
  };

  HumaxEpgUi.prototype._detachChrome = function () {
    if (this._bar && this._bar.parentNode) {
      this._bar.parentNode.removeChild(this._bar);
    }
    if (this._hitRail && this._hitRail.parentNode) {
      this._hitRail.parentNode.removeChild(this._hitRail);
    }
  };

  HumaxEpgUi.prototype.ensureNavBar = function () {
    var thead = this.epgContainer && this.epgContainer.querySelector('.thead');
    if (!thead) return;

    if (!this._bar) {
      var bar = document.createElement('div');
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
    }

    if (thead.firstElementChild !== this._bar) {
      thead.insertBefore(this._bar, thead.firstChild);
    }

    if (!this._barWired) {
      this._barWired = true;
      this._syncNavInputs(new Date());
      this._bindSearchInput(this._bar.querySelector('#epg-nav-search'));
      var self = this;
      this._bar.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-nav]');
        if (!btn) return;
        var action = btn.getAttribute('data-nav');
        if (action === 'clear-search') {
          self.applySearch('');
          return;
        }
        self._handleNav(action);
      });
      this._bar.querySelector('#epg-nav-date').addEventListener('change', function () {
        self._handleNav('go');
      });
      this._bar.querySelector('#epg-nav-time').addEventListener('keydown', function (e) {
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

  HumaxEpgUi.prototype.ensureHitRail = function () {
    var thead = this.epgContainer && this.epgContainer.querySelector('.thead');
    if (!thead || !this._bar) return;

    if (!this._hitRail) {
      var rail = document.createElement('div');
      rail.id = 'epg-hit-rail';
      rail.innerHTML =
        '<div class="epg-hit-controls">' +
        '<button type="button" data-hit="prev" title="Previous hit (Shift+Enter)">◀ Hit</button>' +
        '<span id="epg-hit-pos">—</span>' +
        '<button type="button" data-hit="next" title="Next hit (Enter)">Hit ▶</button>' +
        '</div>' +
        '<div class="epg-hit-map" id="epg-hit-map"></div>';
      this._hitRail = rail;
    }

    // Below nav, above Day/Time row
    if (this._hitRail.parentNode !== thead || this._bar.nextElementSibling !== this._hitRail) {
      if (this._bar.nextSibling) {
        thead.insertBefore(this._hitRail, this._bar.nextSibling);
      } else {
        thead.appendChild(this._hitRail);
      }
    }

    if (!this._hitWired) {
      this._hitWired = true;
      var self = this;
      this._hitRail.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-hit]');
        if (!btn) return;
        if (btn.getAttribute('data-hit') === 'prev') self.goToHit(self._hitIndex - 1);
        else self.goToHit(self._hitIndex + 1);
      });
      this._hitRail.addEventListener('click', function (e) {
        var mark = e.target.closest('.epg-hit-mark');
        if (!mark) return;
        var idx = parseInt(mark.dataset.hitIndex, 10);
        if (!isNaN(idx)) self.goToHit(idx);
      });
    }

    this._renderHitRail();
  };

  HumaxEpgUi.prototype._buildHitList = function (channels, q) {
    var hits = [];
    if (!q) return hits;
    channels.forEach(function (ch) {
      (ch.programList || []).forEach(function (p) {
        if (!programMatches(p, q)) return;
        hits.push({
          startDate: p.startDate,
          stopDate: p.stopDate,
          title: p.title,
          channelName: ch.channelName,
          tvgId: ch.tvgId,
        });
      });
    });
    hits.sort(function (a, b) {
      return a.startDate - b.startDate;
    });
    return hits;
  };

  HumaxEpgUi.prototype._renderHitRail = function () {
    if (!this._hitRail) return;
    var q = this._lastQuery;
    var map = this._hitRail.querySelector('#epg-hit-map');
    var pos = this._hitRail.querySelector('#epg-hit-pos');
    var x = this.xmlepg;

    if (!q || !this._hits.length || !x || !this._bounds) {
      this._hitRail.classList.remove('epg-hit-rail-visible');
      if (map) map.innerHTML = '';
      if (pos) pos.textContent = '—';
      return;
    }

    this._hitRail.classList.add('epg-hit-rail-visible');
    var mapWidth = this._bounds.timelineLength * x.oneUnit;
    map.style.width = mapWidth + 'px';
    map.innerHTML = '';

    var self = this;
    this._hits.forEach(function (hit, i) {
      var mins = x.getMinutesSinceEarliestStartDate(
        self._bounds.earliestStartDate,
        hit.startDate
      );
      var dur = Math.max(
        4,
        x.getDurationInMinutes(hit.startDate, hit.stopDate) * x.oneUnit
      );
      var mark = document.createElement('div');
      mark.className = 'epg-hit-mark' + (i === self._hitIndex ? ' active' : '');
      mark.dataset.hitIndex = String(i);
      mark.style.left = mins * x.oneUnit + 'px';
      mark.style.width = Math.min(dur, 80) + 'px';
      mark.title = hit.channelName + ' — ' + hit.title;
      map.appendChild(mark);
    });

    if (pos) {
      pos.textContent =
        this._hitIndex >= 0
          ? this._hitIndex + 1 + ' / ' + this._hits.length
          : '0 / ' + this._hits.length;
    }
  };

  HumaxEpgUi.prototype.goToHit = function (index) {
    if (!this._hits.length) return;
    var n = this._hits.length;
    var i = ((index % n) + n) % n;
    this._hitIndex = i;
    var hit = this._hits[i];
    this.scrollToDateTime(hit.startDate);
    this._syncNavInputs(hit.startDate);
    this._renderHitRail();
    this._flashHitProgramme(hit);
  };

  HumaxEpgUi.prototype._flashHitProgramme = function (hit) {
    var rows = this.epgContainer.querySelectorAll('.table > .row');
    rows.forEach(function (row) {
      if (row.dataset.tvgId !== hit.tvgId) return;
      row.querySelectorAll('.program-cell').forEach(function (cell) {
        cell.classList.remove('search-hit-active');
        if (cell.dataset.startMs === String(hit.startDate.getTime())) {
          cell.classList.add('search-hit-active');
          cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      });
    });
  };

  HumaxEpgUi.prototype._syncNavWidth = function () {
    if (!this._bar || !this.epgContainer) return;
    this._bar.style.width = this.epgContainer.clientWidth + 'px';
  };

  HumaxEpgUi.prototype._syncSearchInputs = function (raw) {
    var val = raw == null ? '' : String(raw);
    // Keep typed value including trailing spaces while focusing; trim only for query
    if (this.searchInput && document.activeElement !== this.searchInput) {
      if (this.searchInput.value !== val) this.searchInput.value = val;
    }
    var navSearch = document.getElementById('epg-nav-search');
    if (navSearch && document.activeElement !== navSearch) {
      if (navSearch.value !== val) navSearch.value = val;
    }
  };

  HumaxEpgUi.prototype.showNavBar = function () {
    if (this._bar) this._bar.classList.add('epg-nav-visible');
    if (this._hitRail && this._lastQuery) {
      this._hitRail.classList.add('epg-hit-rail-visible');
    }
  };

  HumaxEpgUi.prototype.hideNavBar = function () {
    if (this._bar) this._bar.classList.remove('epg-nav-visible');
    if (this._hitRail) this._hitRail.classList.remove('epg-hit-rail-visible');
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
    if (action === 'now') d = new Date();
    else if (action === 'day-1') d.setDate(d.getDate() - 1);
    else if (action === 'day+1') d.setDate(d.getDate() + 1);
    else if (action === 'h-3') d.setHours(d.getHours() - 3);
    else if (action === 'h-1') d.setHours(d.getHours() - 1);
    else if (action === 'h+1') d.setHours(d.getHours() + 1);
    else if (action === 'h+3') d.setHours(d.getHours() + 3);
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
    var q = this._lastQuery;
    var list = channel.programList || [];
    this.epgContainer.style.display = 'none';
    this.hideNavBar();
    if (this.overlay) this.overlay.style.display = 'flex';
    var oldNote = document.getElementById('overlay-search-note');
    if (oldNote) oldNote.remove();
    this.xmlepg.displayPrograms('overlay', channel.tvgId);
    if (q && list.length && this.overlay) {
      var note = document.createElement('div');
      note.id = 'overlay-search-note';
      note.textContent =
        'Showing ' +
        list.length +
        ' programme' +
        (list.length === 1 ? '' : 's') +
        ' for “' +
        q +
        '” · Clear search for full schedule';
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
    var focus = this._captureSearchFocus();

    // Keep chrome nodes alive across innerHTML wipe
    this._detachChrome();

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
    this.ensureHitRail();
    this._restoreSearchFocus(focus);

    if (this.epgContainer.style.display !== 'none') {
      if (x.clearTimelineNeedle) x.clearTimelineNeedle();
      x.timelineNeedleRender();
    }
  };

  HumaxEpgUi.prototype.applySearch = function (raw) {
    var self = this;
    var typed = raw == null ? '' : String(raw);
    var q = typed.trim().toLowerCase();
    var queryChanged = q !== this._appliedQuery;
    this._lastQuery = q;

    // Don't overwrite the focused field while typing
    this._syncSearchInputs(typed);

    var all = this.getChannels() || [];
    var filtered = buildFilteredChannels(all, q);
    this._markHits(filtered, q);
    this.renderPlaylist(filtered);

    this._hits = this._buildHitList(filtered, q);
    if (queryChanged) {
      this._hitIndex = this._hits.length ? 0 : -1;
      this._appliedQuery = q;
    } else if (this._hitIndex >= this._hits.length) {
      this._hitIndex = this._hits.length ? 0 : -1;
    }

    var statusText = '';
    if (q) {
      statusText =
        filtered.length +
        ' ch · ' +
        this._hits.length +
        ' hit' +
        (this._hits.length === 1 ? '' : 's');
    }
    var status = document.getElementById('search-status');
    if (status) status.textContent = statusText;
    var navStatus = document.getElementById('epg-nav-search-status');
    if (navStatus) navStatus.textContent = statusText;

    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(function () {
      self.rebuildTimeline(filtered).then(function () {
        if (queryChanged && self._hitIndex >= 0) {
          self.goToHit(self._hitIndex);
        } else {
          self._renderHitRail();
        }
      });
    }, 200);
  };

  HumaxEpgUi.prototype.onTimelineOpened = function () {
    this.captureBounds();
    this.ensureNavBar();
    this.ensureHitRail();
    if (this._lastQuery) {
      this.applySearch(this._lastQuery);
    } else {
      this._viewChannels = this.getChannels() || [];
      this.xmlepg.channels = this._viewChannels;
      this.annotateTimeline();
      this._syncNavInputs(new Date());
      this.renderPlaylist(this._viewChannels);
      this._hits = [];
      this._hitIndex = -1;
      this._renderHitRail();
    }
  };

  global.HumaxEpgUi = HumaxEpgUi;
})(window);
