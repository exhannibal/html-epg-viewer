/**
 * Humax / HA enhancements for html-epg-viewer:
 * - live search across program titles/descriptions (filters channels, highlights timeline)
 * - date/time jump navigation on the EPG timeline
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
    const t = timeStr && timeStr.length ? timeStr : '00:00';
    const parts = t.split(':');
    const d = new Date(dateStr + 'T00:00:00');
    d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
    return d;
  }

  function channelMatches(channel, q) {
    if (!q) return true;
    const name = (channel.channelName || '').toLowerCase();
    if (name.includes(q)) return true;
    const list = channel.programList || [];
    return list.some(function (p) {
      return (
        (p.title || '').toLowerCase().includes(q) ||
        (p.desc || '').toLowerCase().includes(q)
      );
    });
  }

  function programMatches(p, q) {
    if (!q) return false;
    return (
      (p.title || '').toLowerCase().includes(q) ||
      (p.desc || '').toLowerCase().includes(q)
    );
  }

  function HumaxEpgUi(opts) {
    this.xmlepg = opts.xmlepg;
    this.epgContainer = opts.epgContainer;
    this.videoList = opts.videoList;
    this.searchInput = opts.searchInput;
    this.getChannels = opts.getChannels; // () => current full channel list
    this.onPlaylistClick = opts.onPlaylistClick; // (channel) => void
    this._navBuilt = false;
    this._lastQuery = '';
    this._debounce = null;
  }

  HumaxEpgUi.prototype.install = function () {
    var self = this;
    if (this.searchInput) {
      this.searchInput.placeholder = 'Search programmes & channels…';
      this.searchInput.addEventListener('input', function () {
        clearTimeout(self._debounce);
        self._debounce = setTimeout(function () {
          self.applySearch(self.searchInput.value);
        }, 120);
      });
      this.searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          self.searchInput.value = '';
          self.applySearch('');
        }
      });
    }
  };

  HumaxEpgUi.prototype.ensureNavBar = function () {
    if (this._navBuilt) return;
    var bar = document.createElement('div');
    bar.id = 'epg-nav-bar';
    bar.innerHTML =
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
      '</div>' +
      '<div class="epg-nav-group epg-nav-hint">Arrow keys still nudge; Esc clears search</div>';
    this.epgContainer.appendChild(bar);
    this._syncNavInputs(new Date());
    var self = this;
    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-nav]');
      if (!btn) return;
      self._handleNav(btn.getAttribute('data-nav'));
    });
    bar.querySelector('#epg-nav-date').addEventListener('change', function () {
      self._handleNav('go');
    });
    bar.querySelector('#epg-nav-time').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') self._handleNav('go');
    });
    this._navBuilt = true;
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
    } else if (action === 'go') {
      /* use inputs as-is */
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
    var channels = this.getChannels() || [];
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
        cell.dataset.title = prog.title || '';
        cell.dataset.desc = prog.desc || '';
        cell.dataset.startMs = String(prog.startDate.getTime());
      });
    }
  };

  HumaxEpgUi.prototype.renderPlaylist = function (list) {
    var self = this;
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
        self.onPlaylistClick(channel);
        var kids = self.videoList.getElementsByTagName('li');
        for (var i = 0; i < kids.length; i++) kids[i].classList.remove('active');
        li.classList.add('active');
      });
      self.videoList.appendChild(li);
    });
  };

  HumaxEpgUi.prototype.applySearch = function (raw) {
    var q = (raw || '').trim().toLowerCase();
    this._lastQuery = q;
    var all = this.getChannels() || [];
    var matchedChannels = all.filter(function (ch) {
      return channelMatches(ch, q);
    });
    this.renderPlaylist(matchedChannels);

    var rows = this.epgContainer.querySelectorAll('.table > .row');
    var firstHitStart = null;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var tvgId = row.dataset.tvgId;
      var ch = all.find(function (c) {
        return c.tvgId === tvgId;
      });
      var show = !q || (ch && channelMatches(ch, q));
      row.classList.toggle('epg-row-hidden', !show);
      if (!show) continue;

      var cells = row.querySelectorAll('.program-cell');
      cells.forEach(function (cell) {
        cell.classList.remove('search-hit', 'search-miss');
        if (!q) return;
        var hit =
          (cell.dataset.title || '').toLowerCase().includes(q) ||
          (cell.dataset.desc || '').toLowerCase().includes(q);
        cell.classList.add(hit ? 'search-hit' : 'search-miss');
        if (hit && firstHitStart === null && cell.dataset.startMs) {
          firstHitStart = parseInt(cell.dataset.startMs, 10);
        }
      });
    }

    var status = document.getElementById('search-status');
    if (status) {
      if (!q) {
        status.textContent = '';
      } else {
        status.textContent =
          matchedChannels.length +
          ' channel' +
          (matchedChannels.length === 1 ? '' : 's') +
          ' · highlighted matches on timeline';
      }
    }

    if (q && firstHitStart) {
      this.scrollToDateTime(new Date(firstHitStart));
      this._syncNavInputs(new Date(firstHitStart));
    }
  };

  HumaxEpgUi.prototype.onTimelineOpened = function () {
    this.ensureNavBar();
    this.annotateTimeline();
    if (this._lastQuery) this.applySearch(this._lastQuery);
    else this._syncNavInputs(new Date());
  };

  global.HumaxEpgUi = HumaxEpgUi;
})(window);
