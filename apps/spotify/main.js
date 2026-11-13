'use strict';
/**
 * Spotify - native BMW iDrive 7 (MGU) Spotify Connect library & playlist browser.
 *
 * Operational Rules:
 *   1. Default Mode: Starts in Online Mode by default.
 *   2. Network Safeguard: In Online Mode, verifies active internet connectivity to Spotify.
 *      If offline, app is disabled with a high-contrast "No Internet Connection" lock screen.
 *   3. Connection Requirement: In Online Mode, requires authenticated personal account.
 *      Gates the player until paired; defaults to Connect tab on first launch.
 *   4. Real Cloud Pairing (No 127.0.0.1): Uses a real cloud pairing relay so any phone on
 *      4G, 5G, or Wi-Fi can scan the QR code and pair directly with Spotify OAuth.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { SpotifyClient } = require('./api');
const { CloudPairManager } = require('./cloud_pair');
const { AlbumArtManager, ART_IMG_ID } = require('./art');
const qrcodegen = require('./kit/qrcodegen');

const W = 1600, H = 520;
const PAGES = ['Playlists', 'Liked Songs', 'Now playing', 'Connect'];

/*
 * Sizes on this display (kit/runtime/panel.js): k = 1.2 on a 12.3" display, 1.44 on a 10.25" one, so rows,
 * buttons and text come out the same size in millimetres on both (as CarPlay sizes its own). sz(cv, n): n at
 * the reference size (k = 1), rounded.
 */
const kOf = (cv) => (cv.ui && cv.ui.k) || 1.44;
/** The quietest text (hints, numbers) and the colour of what plays (its title, the toggles that are on). */
const faint = (t) => t.faint || withAlpha(t.dim, 0.7);
const playingCol = (t) => t.accent2 || t.accent;
const sz = (cv, n) => Math.round(n * kOf(cv));
/**
 * List metrics: song rows (step: one row to the next; h: drawn), playlist rows, the dock at the bottom. The rows
 * are the HMI's own list rows: on the 10.25" display (k 1.44) 74 page px, the 86 screen px of a native row, with
 * its text (26 page px, the HMI's 30) and second line (20, its 23); rows touch, a hairline between them.
 */
function metrics(cv) {
    const ex = cv.extra || 0, dockH = sz(cv, 56);
    const dockY = 512 + ex - dockH;
    const songStep = sz(cv, 51), plStep = sz(cv, 51);
    return {
        dockH, dockY,
        panelH: dockY - 6 - 44,                 // the panels over the dock
        songStep, songH: songStep, plStep, plH: plStep,
        listTop: 92, listBottom: dockY - 4,      // where rows go inside a panel over the dock
        title: sz(cv, 18), meta: sz(cv, 14), num: sz(cv, 13),
    };
}
/** Row text as the HMI sets it: its regular weight, opened up a little (the kit's font is a narrow one). */
const ROW = { font: 'label', spacing: 0.6 };
const SUB = { font: 'label', spacing: 0.4 };

// Format milliseconds as MM:SS
function fmtTime(ms) {
    if (!ms || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return m + ':' + (rem < 10 ? '0' : '') + rem;
}

// String truncation with clean ellipsis
function trunc(str, maxLen) {
    if (!str || typeof str !== 'string') return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '..' : str;
}

// iDrive scroll bar (the kit's: a hairline track, a light thumb); a tap on its upper or lower half scrolls
function drawScrollbar(cv, t, x, y, h, total, visibleCount, scrollOffset, onScrollUp, onScrollDown) {
    if (total <= visibleCount) return;
    G.scrollbar(cv, t, x + 2, y, h, total, visibleCount, scrollOffset);

    // Touch targets: tapping upper half scrolls up, lower half scrolls down
    if (onScrollUp) {
        cv.target(x - 12, y, 30, Math.floor(h / 2), onScrollUp, 'sb_up_' + x, 3, { touch: true });
    }
    if (onScrollDown) {
        cv.target(x - 12, y + Math.floor(h / 2), 30, Math.ceil(h / 2), onScrollDown, 'sb_down_' + x, 3, { touch: true });
    }
}

// Mini animated equalizer icon for list rows (4 bars)
function drawMiniEqualizer(cv, cx, cy, col, isPlaying, seed) {
    const bars = 4;
    const barW = 3.5;
    const gap = 2.5;
    const totalW = bars * barW + (bars - 1) * gap;
    const startX = cx - totalW / 2;
    for (let i = 0; i < bars; i++) {
        let h;
        if (isPlaying) {
            const phase = seed * 3.2 + i * 1.8;
            h = Math.round(Math.abs(Math.sin(phase)) * 14 + 6);
        } else {
            h = [8, 14, 18, 10][i];
        }
        const bx = startX + i * (barW + gap);
        cv.roundRect(bx, cy - h / 2, barW, h, 1.5, col);
    }
}

// Helper to draw anti-aliased triangles across Recorder and Canvas
function drawTriangle(cv, p0, p1, p2, col) {
    if (cv.triangle) {
        cv.triangle([p0, p1, p2], col);
    } else {
        cv.quad([p0, p1, p2, p2], col);
    }
}

// Vector transport icon drawing helpers
function drawPlayIcon(cv, cx, cy, sz, col) {
    const hw = sz * 0.46, hh = sz * 0.52;
    drawTriangle(cv,
        [cx - hw * 0.7, cy - hh],
        [cx + hw * 1.15, cy],
        [cx - hw * 0.7, cy + hh],
        col
    );
}

function drawPauseIcon(cv, cx, cy, sz, col) {
    const barW = Math.max(3, Math.round(sz * 0.26));
    const barH = Math.round(sz * 0.95);
    const gap = Math.max(3, Math.round(sz * 0.28));
    cv.roundRect(cx - gap / 2 - barW, cy - barH / 2, barW, barH, Math.min(barW / 2, 2), col);
    cv.roundRect(cx + gap / 2, cy - barH / 2, barW, barH, Math.min(barW / 2, 2), col);
}

function drawNextIcon(cv, cx, cy, sz, col) {
    const tw = sz * 0.52, th = sz * 0.46;
    const barW = Math.max(3, Math.round(sz * 0.18));
    const gap = Math.max(3, Math.round(sz * 0.14));
    const totalW = tw + gap + barW;
    const left = cx - totalW / 2;
    drawTriangle(cv,
        [left, cy - th],
        [left + tw, cy],
        [left, cy + th],
        col
    );
    cv.roundRect(left + tw + gap, cy - th, barW, th * 2, Math.min(barW / 2, 2), col);
}

function drawPrevIcon(cv, cx, cy, sz, col) {
    const tw = sz * 0.52, th = sz * 0.46;
    const barW = Math.max(3, Math.round(sz * 0.18));
    const gap = Math.max(3, Math.round(sz * 0.14));
    const totalW = tw + gap + barW;
    const left = cx - totalW / 2;
    cv.roundRect(left, cy - th, barW, th * 2, Math.min(barW / 2, 2), col);
    drawTriangle(cv,
        [left + barW + gap + tw, cy - th],
        [left + barW + gap, cy],
        [left + barW + gap + tw, cy + th],
        col
    );
}

/** A smooth S from (x0,y0) to (x1,y1): flat at both ends (a cubic ease), as points for a polyline. */
function sCurve(x0, y0, x1, y1, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const u = i / n, e = u * u * (3 - 2 * u);
        pts.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * e]);
    }
    return pts;
}

/** An arrowhead (open chevron) at (x,y) pointing along angle dir (radians, 0 = right). */
function drawArrowHead(cv, x, y, dir, len, width, col) {
    [2.45, -2.45].forEach((a) => {
        cv.line(x, y, x + Math.cos(dir + a) * len, y + Math.sin(dir + a) * len, width, col);
    });
    cv.circle(x, y, width / 2, col);
}

function drawShuffleIcon(cv, cx, cy, sz, col) {
    const w = sz, h = sz * 0.56, lw = Math.max(2, sz * 0.1);
    const x0 = cx - w / 2, x1 = cx + w / 2 - lw;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const run = w * 0.18;                       // flat lead-in and lead-out
    // top-left to bottom-right, and bottom-left to top-right, crossing in the middle
    cv.polyline([[x0, y0]].concat(sCurve(x0 + run, y0, x1 - run, y1, 14), [[x1, y1]]), lw, col);
    cv.polyline([[x0, y1]].concat(sCurve(x0 + run, y1, x1 - run, y0, 14), [[x1, y0]]), lw, col);
    const ah = sz * 0.26;
    drawArrowHead(cv, x1 + lw * 0.4, y0, 0, ah, lw, col);
    drawArrowHead(cv, x1 + lw * 0.4, y1, 0, ah, lw, col);
}

function drawRepeatIcon(cv, cx, cy, sz, col, mode) {
    const w = sz, h = sz * 0.62, lw = Math.max(2, sz * 0.1);
    const r = h * 0.42, hl = lw / 2;
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    // a rounded loop, open at the top right where the arrow points into it
    cv.line(x0 + r, y0, x1 - r - sz * 0.22, y0, lw, col);                  // top (stops at the gap)
    cv.arc(x1 - r, y0 + r, r - hl, r + hl, 0, 90, col);                    // top-right corner
    cv.line(x1, y0 + r, x1, y1 - r, lw, col);
    cv.arc(x1 - r, y1 - r, r - hl, r + hl, 90, 180, col);
    cv.line(x1 - r, y1, x0 + r + sz * 0.22, y1, lw, col);                  // bottom (gap at the left)
    cv.arc(x0 + r, y1 - r, r - hl, r + hl, 180, 270, col);
    cv.line(x0, y1 - r, x0, y0 + r, lw, col);
    cv.arc(x0 + r, y0 + r, r - hl, r + hl, 270, 360, col);
    const ah = sz * 0.24;
    drawArrowHead(cv, x1 - r - sz * 0.22 + ah * 0.5, y0, 0, ah, lw, col);
    drawArrowHead(cv, x0 + r + sz * 0.22 - ah * 0.5, y1, Math.PI, ah, lw, col);
    if (mode === 'track') {
        // repeat one: a small "1" badge on the loop
        cv.circle(x1, y0, sz * 0.3, col);
        cv.text('1', x1, y0 + sz * 0.13, Math.round(sz * 0.38), '#000000', { align: 'center', font: 'bold' });
    }
}

/** A heart: two lobes and a point, filled, or as an outline. */
function drawHeartIcon(cv, cx, cy, sz, col, filled) {
    const r = sz * 0.27, d = r * 0.9;
    const ly = cy - sz * 0.5 + r + sz * 0.06;          // the lobes' centres
    const tipY = ly + d + 1.414 * r;
    const dip = ly - Math.sqrt(r * r - d * d);
    const lT = [cx - d - 0.707 * r, ly + 0.707 * r], rT = [cx + d + 0.707 * r, ly + 0.707 * r];
    if (filled) {
        cv.circle(cx - d, ly, r, col);
        cv.circle(cx + d, ly, r, col);
        cv.quad([lT, [cx, dip], rT, [cx, tipY]], col);
        return;
    }
    const lw = Math.max(2, sz * 0.1), hl = lw / 2;
    const tA = Math.atan2(d, ly - dip) * 180 / Math.PI;       // where the lobes meet, from each centre
    cv.arc(cx - d, ly, r - hl, r + hl, 225, 360, col);
    cv.arc(cx - d, ly, r - hl, r + hl, 0, tA, col);
    cv.arc(cx + d, ly, r - hl, r + hl, 360 - tA, 360, col);
    cv.arc(cx + d, ly, r - hl, r + hl, 0, 135, col);
    cv.line(lT[0], lT[1], cx, tipY, lw, col);
    cv.line(rT[0], rT[1], cx, tipY, lw, col);
    cv.circle(cx, tipY, hl, col);
}

/** A loading spinner: a faint ring and a turning arc (moves with each frame drawn). */
function drawSpinner(cv, cx, cy, r, col, lw) {
    lw = lw || Math.max(2, r * 0.3);
    const r0 = r - lw / 2, r1 = r + lw / 2;
    cv.arc(cx, cy, r0, r1, 0, 360, withAlpha(col, 0.2));
    const a0 = (Date.now() / 2.4) % 360, a1 = a0 + 110;
    if (a1 <= 360) cv.arc(cx, cy, r0, r1, a0, a1, col, { round: true });
    else {
        cv.arc(cx, cy, r0, r1, a0, 360, col, { round: true });
        cv.arc(cx, cy, r0, r1, 0, a1 - 360, col, { round: true });
    }
}

/** The row that closes a list while its next page loads: a spinner and what loads. */
function drawLoadingRow(cv, t, x, y, w, label, h) {
    h = h || 42;
    const size = sz(cv, 12.5);
    drawSpinner(cv, x + sz(cv, 18), y + h / 2, sz(cv, 7), t.accent);
    cv.text(label, x + sz(cv, 42), y + h / 2 + size * 0.36, size, t.dim);
}

/**
 * A button in the HMI's style (the kit's G.pushButton face) with its label in sentence case, pressed by
 * a tap or the controller (target key). o: { primary, on, busy (dimmed, a spinner, nothing to press),
 * spin (a spinner before the label), chevron (a "go on" chevron after it), color }.
 */
function drawButton(cv, t, x, y, w, h, label, key, run, o) {
    o = o || {};
    G.pushButton(cv, t, x, y, w, h, Object.assign({}, o, { focus: !!run && G.isFocus(cv, key) }));
    const size = Math.round(Math.min(sz(cv, 14), h * 0.44)), opts = { align: 'center', font: 'label', spacing: 0.5 };
    const lw = cv.textWidth(label, size, opts), cx = x + w / 2 + (o.spin ? size * 0.7 : 0) - (o.chevron ? size * 0.45 : 0);
    if (o.spin) drawSpinner(cv, cx - lw / 2 - size, y + h / 2, size * 0.42, o.primary ? '#ffffff' : t.accent);
    cv.text(label, cx, y + h / 2 + size * 0.36, size, o.busy && !o.spin ? t.dim : t.text, opts);
    if (o.chevron) G.chevron(cv, cx + lw / 2 + size * 0.85, y + h / 2, size * 0.42, t.dim);
    if (run && !o.busy) cv.target(x, y, w, h, run, key, 3, { own: true });
}
/** A button's face for an icon (transport, toggles): o as G.pushButton's, the focus bar when the controller is on key. */
function iconButton(cv, t, x, y, w, h, key, o) {
    G.pushButton(cv, t, x, y, w, h, Object.assign({}, o, { focus: G.isFocus(cv, key) }));
}

/** A message in place of a page (no internet, login needed): the HMI's info sign, a title, lines, buttons. */
function drawMessage(cv, t, o) {
    const ex = cv.extra || 0, x = 220, cy = 210 + Math.floor(ex / 2);
    G.infoSign(cv, t, 140, cy - 10, sz(cv, 26), o.warn);
    cv.text(o.title, x, cy, sz(cv, 22), t.text, { font: 'light' });
    let y = cy + sz(cv, 22);
    (o.lines || []).forEach((l, i) => {
        const size = sz(cv, i ? 12.5 : 14);
        cv.text(fitText(cv, l, 1300, size), x, y + size, size, i ? t.dim : withAlpha(t.text, 0.85));
        y += Math.round(size * 1.75);
    });
    const bh = sz(cv, 38);
    let bx = x;
    y += sz(cv, 14);
    (o.buttons || []).forEach((b) => {
        const bw = Math.max(sz(cv, 150), cv.textWidth(b.label, sz(cv, 13)) + sz(cv, 60));
        drawButton(cv, t, bx, y, bw, bh, b.label, b.key, b.run, b);
        bx += bw + sz(cv, 14);
    });
}

/** A device's kind as a small line glyph (phone, computer, speaker, TV, car; others a speaker). */
function drawDeviceIcon(cv, cx, cy, type, col) {
    const k = String(type || '').toLowerCase();
    const lw = 2;
    if (k === 'smartphone' || k === 'tablet') {
        const w = k === 'tablet' ? 20 : 14, h = 24;
        cv.strokeRoundRect(cx - w / 2, cy - h / 2, w, h, 3, lw, col);
        cv.line(cx - 2.5, cy + h / 2 - 4, cx + 2.5, cy + h / 2 - 4, lw, col);
    } else if (k === 'computer') {
        cv.strokeRoundRect(cx - 13, cy - 11, 26, 17, 2, lw, col);
        cv.line(cx - 16, cy + 10, cx + 16, cy + 10, lw, col);
    } else if (k === 'tv') {
        cv.strokeRoundRect(cx - 14, cy - 10, 28, 18, 2, lw, col);
        cv.line(cx - 6, cy + 12, cx + 6, cy + 12, lw, col);
    } else if (k === 'automobile') {
        cv.strokeRoundRect(cx - 15, cy - 3, 30, 11, 4, lw, col);
        cv.line(cx - 9, cy - 3, cx - 5, cy - 10, lw, col);
        cv.line(cx - 5, cy - 10, cx + 6, cy - 10, lw, col);
        cv.line(cx + 6, cy - 10, cx + 10, cy - 3, lw, col);
        cv.circle(cx - 8, cy + 9, 3, col);
        cv.circle(cx + 8, cy + 9, 3, col);
    } else {
        cv.strokeRoundRect(cx - 10, cy - 13, 20, 26, 4, lw, col);
        cv.arc(cx, cy + 3, 4, 6, 0, 360, col);
        cv.circle(cx, cy - 7, 2, col);
    }
}

/** A spinner just left of a centred loading title (str drawn at cx, baseline y, this size). */
function drawSpinnerBefore(cv, str, cx, y, size, col) {
    const w = cv.textWidth ? cv.textWidth(str, size, { font: 'label' }) : str.length * size * 0.6;
    drawSpinner(cv, cx - w / 2 - size, y - size * 0.36, size * 0.42, col);
}

/** str cut (with "..") to fit maxW pixels at this size: room decides, not a character count. */
function fitText(cv, str, maxW, size, opts) {
    str = String(str || '');
    if (!cv.textWidth || cv.textWidth(str, size, opts) <= maxW) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cv.textWidth(str.slice(0, mid).replace(/\s+$/, '') + '..', size, opts) <= maxW) lo = mid; else hi = mid - 1;
    }
    return str.slice(0, lo).replace(/\s+$/, '') + '..';
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log, dataDir } = ctx;
        const spotify = new SpotifyClient(ctx);
        const artManager = new AlbumArtManager(log, () => render());

        function notify(msg) {
            log.info('Spotify: ' + msg);
        }

        const cloudPair = new CloudPairManager(ctx, spotify);
        cloudPair.onPaired = () => {
            notify('Spotify Paired via Secure Cloud!');
            page = 0; // Automatically switch to Playlists upon pairing!
            spotify.initialFetch();
            render().catch(() => {});
        };
        cloudPair.onUnpaired = () => {
            spotify.logout();
            cachedQr = null;
            cachedQrUrl = null;
            cloudPair.reset();
            cloudPair.startPolling();
            artManager.load(null);
            page = 3;
            notify('Spotify Disconnected.');
            render().catch(() => {});
        };
        // background: no internet checks, no player polls and no relay stream (its keepalives would
        // wake the app all drive); what the phone sent meanwhile is read when the screen is back
        // (the relay keeps 12 h), as M-Copilot does
        const onScreen = () => !ui.isVisible || ui.isVisible('MAIN');
        spotify.isOnScreen = onScreen;
        if (ui.onVisible) ui.onVisible((name, visible) => {
            if (name !== 'MAIN') return;
            if (visible) cloudPair.startPolling(); else cloudPair.stopPolling();
        });
        if (onScreen()) cloudPair.startPolling();

        // Default to Online mode (demo !== 'on')
        // If not authenticated, open directly on the Connect tab!
        // read each time: the demo setting can change while the app runs
        const isOnlineMode = () => settings.get('demo') !== 'on';
        let page = (isOnlineMode() && !spotify.isAuthenticated()) ? 3 : 0;
        let showPhoneQr = false;        // Connect, paired: the phone page's QR code in place of the account card
        // the demo switched on or off (Settings, or the offline screen's button): its data in or out
        settings.onChange((k, v) => {
            if (k !== 'demo') return;
            spotify.setDemoMode(v === 'on');
            if (v !== 'on' && !spotify.isAuthenticated()) page = 3;      // to the pairing QR
            render();
        });
        let selectedPlaylistIdx = 0;
        let playlistScroll = 0;
        let trackScroll = 0;
        let likedScroll = 0;
        let queueScroll = 0;

        /*
         * Busy buttons. A tap that has to wait for Spotify (or the network) marks its button busy:
         * it shows a spinner and takes no other tap until the answer is in, so a slow phone is not
         * sent the same command twice. One key per group of buttons that must not overlap:
         *   start     a song started from a list (id: the row)    transport  play/pause, next, previous
         *   shuffle, repeat, like      devices  refresh            transfer   moving playback (id: device)
         *   playlists refresh          net      the internet check
         * A request that never answers frees its button after BUSY_MAX_MS.
         */
        const BUSY_MAX_MS = 12000;
        const busy = {};
        const isBusy = (key) => !!busy[key] && Date.now() - busy[key].at < BUSY_MAX_MS;
        const busyOn = (key, id) => isBusy(key) && busy[key].id === id;
        function runBusy(key, fn, id) {
            if (isBusy(key)) return;
            const mark = { at: Date.now(), id };
            busy[key] = mark;
            let p;
            try { p = Promise.resolve(fn()); } catch (e) { p = Promise.resolve(); log.warn(key + ': ' + e.message); }
            const done = () => { if (busy[key] === mark) delete busy[key]; render(); };
            p.then(done, done);
            render();
        }

        // "Playing" marks follow what Spotify plays (its context and track), not what is selected here
        const playingFrom = (pl) => !!(pl && pl.uri && spotify.contextUri && spotify.contextUri === pl.uri);
        const isPlayingTrack = (trk) => !!(trk && spotify.currentTrack && spotify.currentTrack.id === trk.id);

        // Lists scroll with a finger (the list under it) or the controller (the page's main list).
        // listGeo is filled while a page draws: rows per list, how many show, the list's x range.
        const listGeo = {};
        const scrollGet = { pl: () => playlistScroll, trk: () => trackScroll, liked: () => likedScroll, q: () => queueScroll };
        const scrollSet = { pl: (v) => { playlistScroll = v; }, trk: (v) => { trackScroll = v; }, liked: (v) => { likedScroll = v; }, q: (v) => { queueScroll = v; } };
        let scrollAcc = 0, scrollList = null;
        ctx.onScroll((dy, at) => {
            const names = page === 0 ? ['pl', 'trk'] : page === 1 ? ['liked'] : page === 2 ? ['q'] : [];
            const name = names.find((n) => at && listGeo[n] && at.x >= listGeo[n].x0 && at.x < listGeo[n].x1) || names[names.length - 1];
            const g = name && listGeo[name];
            if (!g) return false;
            if (name !== scrollList) { scrollList = name; scrollAcc = 0; }
            const max = Math.max(0, g.count - g.visible), cur = scrollGet[name]();
            scrollAcc += dy;
            const rows = scrollAcc > 0 ? Math.floor(scrollAcc / g.rowH) : Math.ceil(scrollAcc / g.rowH);
            if (!rows) return (dy > 0 && cur < max) || (dy < 0 && cur > 0);
            scrollAcc -= rows * g.rowH;
            const next = Math.max(0, Math.min(max, cur + rows));
            scrollSet[name](next);
            render().catch(() => {});
            return next !== cur;
        });
        let spectrumSeed = 0;

        /* ---------- Real Cloud Pairing QR Code Generation ---------- */
        let cachedQr = null;
        let cachedQrUrl = null;
        function getQrMatrix() {
            // Use real public pairing URL (works anywhere over 4G/5G/Wi-Fi, zero 127.0.0.1)
            const url = cloudPair.getPairingUrl();
            if (cachedQr && cachedQrUrl === url) return cachedQr;
            try {
                const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
                cachedQr = qr;
                cachedQrUrl = url;
                return qr;
            } catch (e) {
                return null;
            }
        }

        /* ---------- Offline Safeguard Screen: No Internet Connection ---------- */
        function drawNoInternet(cv, t) {
            const netBusy = isBusy('net');
            drawMessage(cv, t, {
                warn: true,
                title: 'No internet connection',
                lines: ['Spotify needs an internet connection in the car.',
                    'Connect the car to a phone hotspot or Wi-Fi, or use a mobile data stick (MGU Store uplink).'],
                buttons: [
                    { label: netBusy ? 'Checking...' : 'Retry', key: 'btn_retry_net', primary: true, busy: netBusy, spin: netBusy,
                        run: () => { runBusy('net', () => spotify.checkInternetConnection()); } },
                    { label: 'Switch to demo mode', key: 'btn_switch_demo',
                        run: () => { settings.set('demo', 'on'); } },        // the change handler brings the demo in
                ],
            });
        }

        /* ---------- Gating Screen: Authentication Required in Online Mode ---------- */
        function drawRequireConnect(cv, t) {
            drawMessage(cv, t, {
                title: 'Spotify login required',
                lines: ['Pair your Spotify account to browse your library and control playback.',
                    'Open Connect and scan its QR code with your phone.'],
                buttons: [{ label: 'Connect phone', key: 'btn_goto_connect', primary: true, chevron: true, run: () => { page = 3; } }],
            });
        }

        /* ---------- Bottom Now Playing Player Dock ---------- */
        function drawBottomPlayerDock(cv, t) {
            const curTrk = spotify.currentTrack;
            const isPlaying = spotify.isPlaying;
            const m = metrics(cv);
            const dockX = 24, dockY = m.dockY, dockW = 1552, dockH = m.dockH;

            // the HMI's media strip: a faint wash, the song's progress as a thin line along its top
            cv.fillRect(dockX, dockY, dockW, dockH, withAlpha('#ffffff', 0.05));
            const dur = (curTrk && curTrk.durationMs) ? curTrk.durationMs : 1;
            G.progress(cv, t, dockX, dockY, dockW, curTrk ? spotify.progressMs / dur : 0, 3);

            // Controls on the right, from the dock's right end: Now Playing button, Next, Play / Pause, Prev
            const bh = sz(cv, 36), by = dockY + 2 + (dockH - bh) / 2, gap = sz(cv, 8);
            const npW = sz(cv, 132), npX = dockX + dockW - 12 - npW;
            const skW = sz(cv, 48), nextX = npX - sz(cv, 22) - skW;
            const playW = sz(cv, 56), playX = nextX - gap - playW;
            const prevX = playX - gap - skW;
            // the song's part (it opens Now playing): the controller's focus bar under the cover and the song
            if (G.isFocus(cv, 'dock_open_np')) G.focusBar(cv, t, dockX, dockY + 3, prevX - 12 - dockX, dockH - 3, 3);

            // Mini artwork / Equalizer box
            const miniSz = dockH - 18, miniX = dockX + 10, miniY = dockY + 11;
            if (artManager.hasArt) {
                cv.image(ART_IMG_ID, miniX, miniY, miniSz, miniSz, 2);
            } else {
                cv.fillRect(miniX, miniY, miniSz, miniSz, t.track);
                drawMiniEqualizer(cv, miniX + miniSz / 2, miniY + miniSz / 2, isPlaying ? t.accent : t.dim, isPlaying, spectrumSeed);
            }

            // Track metadata: up to the time, left of the controls
            const timeW = sz(cv, 100), timeX = prevX - sz(cv, 24) - timeW / 2;
            const textX = miniX + miniSz + 16, dockTextW = timeX - timeW / 2 - 16 - textX;
            const tSize = sz(cv, 15), mSize = sz(cv, 12);
            const tY = dockY + 2 + dockH / 2 - 3, mY = tY + mSize + 6;
            if (curTrk) {
                cv.text(fitText(cv, curTrk.title, dockTextW, tSize), textX, tY, tSize, t.text);
                const metaStr = curTrk.artist + (curTrk.album ? '  -  ' + curTrk.album : '');
                cv.text(fitText(cv, metaStr, dockTextW, mSize), textX, mY, mSize, t.dim);
            } else {
                cv.text('No song playing', textX, tY, tSize, t.dim);
                cv.text(fitText(cv, 'Choose a song in Playlists or Liked Songs', dockTextW, mSize), textX, mY, mSize, faint(t));
            }

            // Tapping the track's part opens the full Now Playing screen
            cv.target(dockX, dockY, prevX - 12 - dockX, dockH, () => {
                page = 2; // Switch to Now Playing screen
                render();
            }, 'dock_open_np', 3, { own: true });

            // Elapsed / Duration timestamp
            if (curTrk) {
                cv.text(fmtTime(spotify.progressMs) + ' / ' + fmtTime(curTrk.durationMs), timeX, dockY + 2 + dockH / 2 + sz(cv, 4.5), sz(cv, 12.5), t.dim, { align: 'center', font: 'num' });
            }

            const tBusy = isBusy('transport');
            // 1. Prev
            iconButton(cv, t, prevX, by, skW, bh, 'dock_prev', { busy: tBusy });
            if (busyOn('transport', 'prev')) drawSpinner(cv, prevX + skW / 2, by + bh / 2, sz(cv, 8), t.text);
            else drawPrevIcon(cv, prevX + skW / 2, by + bh / 2, sz(cv, 14), tBusy ? t.dim : t.text);
            cv.target(prevX, by, skW, bh, () => {
                runBusy('transport', () => spotify.prevTrack(), 'prev');
            }, 'dock_prev', 3, { own: true });

            // 2. Play / Pause: the blue one
            iconButton(cv, t, playX, by, playW, bh, 'dock_play', { primary: true, busy: tBusy });
            if (busyOn('transport', 'play')) drawSpinner(cv, playX + playW / 2, by + bh / 2, sz(cv, 9), '#ffffff');
            else if (isPlaying) drawPauseIcon(cv, playX + playW / 2, by + bh / 2, sz(cv, 15), '#ffffff');
            else drawPlayIcon(cv, playX + playW / 2 + 1, by + bh / 2, sz(cv, 15), '#ffffff');
            cv.target(playX, by, playW, bh, () => {
                runBusy('transport', () => spotify.togglePlay(), 'play');
            }, 'dock_play', 3, { own: true });

            // 3. Next
            iconButton(cv, t, nextX, by, skW, bh, 'dock_next', { busy: tBusy });
            if (busyOn('transport', 'next')) drawSpinner(cv, nextX + skW / 2, by + bh / 2, sz(cv, 8), t.text);
            else drawNextIcon(cv, nextX + skW / 2, by + bh / 2, sz(cv, 14), tBusy ? t.dim : t.text);
            cv.target(nextX, by, skW, bh, () => {
                runBusy('transport', () => spotify.nextTrack(), 'next');
            }, 'dock_next', 3, { own: true });

            // 4. "Now playing >" button
            drawButton(cv, t, npX, by, npW, bh, 'Now playing', 'dock_btn_np', () => {
                page = 2; // Switch to Now Playing screen
                render();
            }, { chevron: true });
        }

        /**
         * A song row (playlist songs, Liked Songs), m.songH high at y, in the HMI's list style (a hairline
         * between rows): number (or the equalizer / a spinner while it plays or starts), a heart (heart: Liked
         * Songs), the title over artist - album (the HMI's two-row entry) and the length; the song that plays has
         * a faint wash and its title in blue; the row the controller is on, the HMI's focus bar under it.
         * o = { x, w, y, idx, trk, playing, starting, heart, key (its target's) }
         */
        function drawSongRow(cv, t, m, o) {
            const { x, w, y, trk } = o, h = m.songH, cy = y + h / 2;
            const focus = G.isFocus(cv, o.key);
            G.listRow(cv, t, x, y, w, h, { active: o.playing, focus });
            if (o.playing) {
                if (o.starting) drawSpinner(cv, x + sz(cv, 20), cy, sz(cv, 7), focus ? '#ffffff' : t.accent);
                else drawMiniEqualizer(cv, x + sz(cv, 20), cy, focus ? '#ffffff' : t.accent, spotify.isPlaying, spectrumSeed);
            } else {
                cv.text(String(o.idx + 1), x + sz(cv, 20), cy + m.num * 0.36, m.num, focus ? withAlpha('#ffffff', 0.75) : faint(t), { align: 'center', font: 'num' });
            }
            let tx = x + sz(cv, 46);
            if (o.heart) { drawHeartIcon(cv, tx + sz(cv, 8), cy, sz(cv, 12), focus ? '#ffffff' : t.accent, true); tx += sz(cv, 30); }
            const timeR = x + w - sz(cv, 16), textR = timeR - sz(cv, 52);
            const tY = y + h * 0.47, sY = y + h * 0.8;
            cv.text(fitText(cv, trk.title, textR - tx, m.title, ROW), tx, tY, m.title, o.playing && !focus ? playingCol(t) : t.text, ROW);
            const metaText = trk.artist + (trk.album ? '  -  ' + trk.album : '');
            cv.text(fitText(cv, metaText, textR - tx, m.meta, SUB), tx, sY, m.meta, focus ? withAlpha('#ffffff', 0.8) : t.dim, SUB);
            cv.text(fmtTime(trk.durationMs), timeR, cy + m.num * 0.36, m.num, focus ? '#ffffff' : t.dim, { align: 'right', font: 'num' });
        }

        /** An empty list's message: what is missing (a spinner while it loads), what to do, an action. */
        function drawEmpty(cv, t, cx, y, title, line, loading) {
            const size = sz(cv, 16);
            cv.text(title, cx, y, size, t.dim, { align: 'center', font: 'label' });
            if (loading) drawSpinnerBefore(cv, title, cx, y, size, t.accent);
            cv.text(line, cx, y + sz(cv, 26), sz(cv, 12.5), faint(t), { align: 'center' });
        }

        /* ---------- Page 0: Playlists & Tracks ---------- */
        function drawPlaylists(cv, t) {
            const playlists = spotify.getPlaylists();

            if (!playlists || playlists.length === 0) {
                if (isOnlineMode() && !spotify.isAuthenticated()) {
                    drawRequireConnect(cv, t);
                } else {
                    G.panelExact(cv, t, 24, 44, 1552, metrics(cv).panelH, 'Playlists');

                    const loading = spotify.isLoadingPlaylists || spotify.syncing;
                    drawEmpty(cv, t, 800, 190, loading ? 'Loading playlists...' : 'No playlists',
                        loading ? 'Fetching your playlists from Spotify.' : 'Create or follow playlists on Spotify, or open Liked Songs.', loading);

                    const plBusy = isBusy('playlists') || spotify.isLoadingPlaylists;
                    const rfW = sz(cv, 180), rfH = sz(cv, 36);
                    drawButton(cv, t, 800 - rfW / 2, 250, rfW, rfH, plBusy ? 'Loading...' : 'Refresh playlists', 'btn_refresh_pls', () => {
                        if (!spotify.isLoadingPlaylists) runBusy('playlists', () => spotify.fetchPlaylists());
                    }, { busy: plBusy, spin: plBusy });

                    drawBottomPlayerDock(cv, t);
                }
                return;
            }

            // Keep selected index valid
            if (selectedPlaylistIdx >= playlists.length) selectedPlaylistIdx = 0;

            // Visible window for playlists (scrolled freely: not pulled back to the selection)
            const m = metrics(cv), listH = m.listBottom - m.listTop;
            const VISIBLE_PL = Math.max(1, Math.floor((listH + 8) / m.plStep));
            playlistScroll = Math.max(0, Math.min(playlistScroll, Math.max(0, playlists.length - VISIBLE_PL)));
            listGeo.pl = { x0: 24, x1: 532, rowH: m.plStep, count: playlists.length, visible: VISIBLE_PL };
            cv.scroll = true;

            // Left Pane: Playlists (w: 500)
            const plTitle = 'Playlists  ' + (selectedPlaylistIdx + 1) + '/' + playlists.length;
            G.panelExact(cv, t, 24, 44, 500, m.panelH, plTitle);

            // Left Pane Scrollbar
            drawScrollbar(cv, t, 508, m.listTop, listH, playlists.length, VISIBLE_PL, playlistScroll, () => {
                playlistScroll = Math.max(0, playlistScroll - 1);
                selectedPlaylistIdx = Math.max(0, selectedPlaylistIdx - 1);
                spotify.selectPlaylist(playlists[selectedPlaylistIdx]);
            }, () => {
                playlistScroll = Math.min(Math.max(0, playlists.length - VISIBLE_PL), playlistScroll + 1);
                selectedPlaylistIdx = Math.min(playlists.length - 1, selectedPlaylistIdx + 1);
                spotify.selectPlaylist(playlists[selectedPlaylistIdx]);
            });

            const visiblePlaylists = playlists.slice(playlistScroll, playlistScroll + VISIBLE_PL);
            visiblePlaylists.forEach((pl, vIdx) => {
                const realIdx = playlistScroll + vIdx;
                const py = m.listTop + vIdx * m.plStep, ph = m.plH;
                const isSel = realIdx === selectedPlaylistIdx;
                const isPlPlaying = playingFrom(pl);       // the playlist Spotify plays from, selected or not

                // the chosen playlist: the row in use (its songs on the right); the controller's: the focus bar
                const key = 'pl_' + realIdx, focus = G.isFocus(cv, key);
                G.listRow(cv, t, 38, py, 460, ph, { active: isSel, focus });
                const plTextW = (isPlPlaying ? 452 : 486) - 62;     // up to the equalizer, or the row's end
                const nSize = m.title, dSize = m.meta;
                const nY = py + ph * 0.47, dY = py + ph * 0.8;
                cv.text(fitText(cv, pl.name, plTextW, nSize, ROW), 58, nY, nSize, isPlPlaying && !focus ? playingCol(t) : t.text, ROW);
                cv.text(fitText(cv, (pl.trackCount || 0) + ' songs  -  ' + (pl.description || 'Playlist'), plTextW, dSize, SUB), 58, dY, dSize, focus ? withAlpha('#ffffff', 0.8) : t.dim, SUB);

                if (isPlPlaying) {
                    drawMiniEqualizer(cv, 474, py + ph / 2, focus ? '#ffffff' : t.accent, spotify.isPlaying, spectrumSeed);
                } else {
                    G.chevron(cv, 486, py + ph / 2, sz(cv, 5.5), focus ? '#ffffff' : faint(t));
                }

                cv.target(38, py, 460, ph, () => {
                    selectedPlaylistIdx = realIdx;
                    trackScroll = 0;
                    spotify.selectPlaylist(pl);
                }, key, 3, { list: 'pl', row: realIdx, step: m.plStep, own: true });
            });

            // Right Pane: Tracks of selected playlist (x: 540, w: 1036, h: 396)
            const curPl = playlists[selectedPlaylistIdx] || playlists[0];
            // the track that plays, in this playlist (another playlist's context marks nothing here)
            const ctxHere = !spotify.contextUri || !/:playlist:/.test(spotify.contextUri) || playingFrom(curPl);
            const trackTotal = curPl.trackCount || (curPl.tracks ? curPl.tracks.length : 0);

            G.panelExact(cv, t, 540, 44, 1036, metrics(cv).panelH, fitText(cv, curPl.name, 760, 25, { font: 'light' }) + '  ·  ' + trackTotal + ' songs');

            // the songs of the playlist shown: fetched (and retried) from here, whatever selected it
            spotify.ensureTracks(curPl);

            if (!curPl.tracks || curPl.tracks.length === 0) {
                const none = !!curPl.tracksLoaded;
                drawEmpty(cv, t, 1058, 200, none ? 'No songs' : 'Loading songs...',
                    none ? 'This playlist has no songs that can be played here.' : 'Fetching the songs from Spotify.', !none);
            } else {
                const m = metrics(cv), listH = m.listBottom - m.listTop;
                const VISIBLE_TRK = Math.max(1, Math.floor((listH + 6) / m.songStep));
                // more songs than loaded: a "loading" row closes the list, and the next page comes
                // as the list nears its end
                const moreTrk = spotify.hasMoreTracks(curPl);
                const trkRows = curPl.tracks.length + (moreTrk ? 1 : 0);
                trackScroll = Math.max(0, Math.min(trackScroll, Math.max(0, trkRows - VISIBLE_TRK)));
                listGeo.trk = { x0: 540, x1: 1576, rowH: m.songStep, count: trkRows, visible: VISIBLE_TRK };
                if (moreTrk && trackScroll + VISIBLE_TRK >= curPl.tracks.length - 5) spotify.loadMoreTracks(curPl);

                // Right Pane Tracks Scrollbar
                drawScrollbar(cv, t, 1554, m.listTop, listH, trkRows, VISIBLE_TRK, trackScroll, () => {
                    trackScroll = Math.max(0, trackScroll - VISIBLE_TRK);
                }, () => {
                    trackScroll = Math.min(Math.max(0, trkRows - VISIBLE_TRK), trackScroll + VISIBLE_TRK);
                });

                const visibleTracks = curPl.tracks.slice(trackScroll, trackScroll + VISIBLE_TRK);
                if (moreTrk && trackScroll + VISIBLE_TRK > curPl.tracks.length) {
                    drawLoadingRow(cv, t, 556, m.listTop + (curPl.tracks.length - trackScroll) * m.songStep, 980,
                        'Loading more songs (' + curPl.tracks.length + ' of ' + (curPl._total || trackTotal) + ')...', m.songH);
                }

                visibleTracks.forEach((trk, vIdx) => {
                    const realIdx = trackScroll + vIdx;
                    const ty = m.listTop + vIdx * m.songStep;
                    const startKey = 'pl:' + curPl.id + ':' + realIdx;
                    const starting = busyOn('start', startKey);
                    const isPlayingThis = starting || (ctxHere && isPlayingTrack(trk));
                    drawSongRow(cv, t, m, { x: 556, w: 980, y: ty, idx: realIdx, trk, playing: isPlayingThis, starting, key: 'trk_' + realIdx });
                    cv.target(556, ty, 980, m.songH, () => {
                        runBusy('start', () => spotify.playTrack(curPl, realIdx), startKey);
                    }, 'trk_' + realIdx, 3, { list: 'trk', row: realIdx, step: m.songStep, own: true });
                });
            }

            // Bottom Player Dock
            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Page 1: Liked Songs ---------- */
        function drawLibrary(cv, t) {
            if (isOnlineMode() && !spotify.isAuthenticated()) {
                drawRequireConnect(cv, t);
                return;
            }

            const liked = (spotify.likedSongs && spotify.likedSongs.length)
                ? spotify.likedSongs
                : (spotify.isDemoMode ? require('./api').DEMO_PLAYLISTS[3].tracks : []);

            const total = spotify.likedTotal || liked.length;
            const m = metrics(cv), listH = m.listBottom - m.listTop;
            const VISIBLE_LIKED = Math.max(1, Math.floor((listH + 6) / m.songStep));
            // more liked songs than loaded: a "loading" row closes the list, the next page comes near its end
            const moreLiked = liked === spotify.likedSongs && spotify.hasMoreLiked();
            const likedRows = liked.length + (moreLiked ? 1 : 0);
            likedScroll = Math.max(0, Math.min(likedScroll, Math.max(0, likedRows - VISIBLE_LIKED)));
            listGeo.liked = { x0: 24, x1: 1576, rowH: m.songStep, count: likedRows, visible: VISIBLE_LIKED };
            if (moreLiked && likedScroll + VISIBLE_LIKED >= liked.length - 5) spotify.loadMoreLiked();
            cv.scroll = true;
            const startIdx = total > 0 ? likedScroll + 1 : 0;
            const endIdx = Math.min(likedScroll + VISIBLE_LIKED, liked.length, total);
            const title = 'Liked Songs  ·  ' + (total > 0 ? (startIdx + '-' + endIdx + ' of ' + total) : '0');

            G.panelExact(cv, t, 24, 44, 1552, m.panelH, title);

            // Liked Songs Scrollbar
            drawScrollbar(cv, t, 1554, m.listTop, listH, likedRows, VISIBLE_LIKED, likedScroll, () => {
                likedScroll = Math.max(0, likedScroll - VISIBLE_LIKED);
            }, () => {
                likedScroll = Math.min(Math.max(0, likedRows - VISIBLE_LIKED), likedScroll + VISIBLE_LIKED);
            });

            if (!liked || liked.length === 0) {
                const loading = spotify.isLoadingLiked || spotify.syncing;
                drawEmpty(cv, t, 800, 190, loading ? 'Loading liked songs...' : 'No liked songs',
                    loading ? 'Fetching your saved songs from Spotify.' : 'Like songs on Spotify to find them here.', loading);
                drawBottomPlayerDock(cv, t);
                return;
            }

            const visible = liked.slice(likedScroll, likedScroll + VISIBLE_LIKED);
            if (moreLiked && likedScroll + VISIBLE_LIKED > liked.length) {
                drawLoadingRow(cv, t, 40, m.listTop + (liked.length - likedScroll) * m.songStep, 1500,
                    'Loading more liked songs (' + liked.length + ' of ' + total + ')...', m.songH);
            }
            visible.forEach((trk, vIdx) => {
                const realIdx = likedScroll + vIdx;
                const ty = m.listTop + vIdx * m.songStep;
                const startKey = 'liked:' + realIdx;
                const starting = busyOn('start', startKey);
                const isPlayingThis = starting || isPlayingTrack(trk);
                drawSongRow(cv, t, m, { x: 40, w: 1500, y: ty, idx: realIdx, trk, playing: isPlayingThis, starting, heart: true, key: 'liked_' + realIdx });

                cv.target(40, ty, 1500, m.songH, () => {
                    runBusy('start', () => spotify.playLikedSong(realIdx), startKey);
                }, 'liked_' + realIdx, 3, { list: 'liked', row: realIdx, step: m.songStep, own: true });
            });

            // Bottom Player Dock
            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Page 2: Now Playing & Queue ---------- */
        function drawNowPlaying(cv, t) {
            if (isOnlineMode() && !spotify.isAuthenticated()) {
                drawRequireConnect(cv, t);
                return;
            }

            const curTrk = spotify.currentTrack;
            const isPlaying = spotify.isPlaying;
            const npEx = cv.extra || 0;        // the panels reach the screen's bottom: controls move with it

            // Left Pane: Now Playing (w: 880, h: 468), as the HMI's media screen: the cover, the song, its progress
            G.panel(cv, t, 24, 44, 880, 468, 'Now playing');

            if (!curTrk) {
                drawEmpty(cv, t, 464, 230, 'No song playing', 'Choose a song in Playlists or Liked Songs to start.');
            } else {
                // Album Art
                const artX = 48, artY = 112, artSz = Math.min(236, sz(cv, 186));      // as tall as the room over the progress bar allows
                if (artManager.hasArt) {
                    cv.image(ART_IMG_ID, artX, artY, artSz, artSz, 2);
                } else {
                    // no cover: a dark square with a quiet note and the equalizer
                    cv.fillRect(artX, artY, artSz, artSz, t.track);
                    drawMiniEqualizer(cv, artX + artSz / 2, artY + artSz / 2, isPlaying ? t.accent : t.dim, isPlaying, spectrumSeed);
                }

                // Right of Album Art: Track Info, as wide as the panel lets it be
                const metaX = artX + artSz + 30, metaW = 880 - metaX;
                const devSize = sz(cv, 11.5), tSize = sz(cv, 26), aSize = sz(cv, 16.5), alSize = sz(cv, 13.5);
                const devY = 112 + devSize, titleY = devY + 18 + tSize, artistY = titleY + aSize + 14, albumY = artistY + alSize + 12;

                // where it plays: the HMI's quiet status line, a blue dot while music plays
                const devName = spotify.activeDevice || '';
                const devLabel = !devName ? 'Spotify Connect'
                    : spotify.stalled ? devName + '  -  not responding'
                    : (isPlaying ? 'Playing on ' : 'Paused on ') + devName;
                G.status(cv, t, metaX, devY, fitText(cv, devLabel, metaW - 30, devSize), spotify.stalled ? t.warn : isPlaying ? t.accent : t.dim, devSize);

                // Title, artist, album: cut only where the panel ends
                cv.text(fitText(cv, curTrk.title, metaW, tSize, { font: 'light' }), metaX, titleY, tSize, t.text, { font: 'light' });
                cv.text(fitText(cv, curTrk.artist, metaW, aSize), metaX, artistY, aSize, withAlpha(t.text, 0.86));
                if (curTrk.album) {
                    cv.text(fitText(cv, curTrk.album, metaW, alSize), metaX, albumY, alSize, t.dim);
                }

                // what it plays from: the playlist, Liked Songs or the album
                const ctxUri = spotify.contextUri || '';
                let fromKind = '', fromName = '';
                if (/:collection$/.test(ctxUri)) { fromKind = 'Liked Songs'; }
                else if (/:playlist:/.test(ctxUri)) {
                    const pl = (spotify.playlists || []).find((p) => p.uri === ctxUri);
                    fromKind = 'playlist'; fromName = pl ? pl.name : '';
                } else if (/:album:/.test(ctxUri)) { fromKind = 'album'; fromName = curTrk.album || ''; }
                else if (/:artist:/.test(ctxUri)) { fromKind = 'artist'; }
                if (fromKind) {
                    const fkSize = sz(cv, 11), fnSize = sz(cv, 13.5), fkY = albumY + 24 + fkSize;
                    cv.text('Playing from ' + fromKind, metaX, fkY, fkSize, faint(t));
                    if (fromName) cv.text(fitText(cv, fromName, metaW, fnSize), metaX, fkY + fnSize + 8, fnSize, t.text);
                }

                // Progress Bar
                const progX = 48, progY = 362 + npEx, progW = 832, progH = 4;
                const dur = (curTrk && curTrk.durationMs) ? curTrk.durationMs : 1;
                const pFrac = Math.min(1, Math.max(0, spotify.progressMs / dur));
                G.progress(cv, t, progX, progY, progW, pFrac, progH);
                cv.circle(progX + Math.round(progW * pFrac), progY + progH / 2, 6, '#ffffff');
                cv.text(fmtTime(spotify.progressMs), progX, progY + 26, 15, t.text, { font: 'num' });
                cv.text(fmtTime(curTrk.durationMs), progX + progW, progY + 26, 15, t.dim, { align: 'right', font: 'num' });
                // a tap on the bar jumps there; the controller pressed on it jumps 15 s on
                const seekPad = 10;
                cv.target(progX - seekPad, progY - 16, progW + seekPad * 2, 34, (at) => {
                    const to = at && at.w
                        ? (Math.max(0, Math.min(progW, at.x - seekPad)) / progW) * dur
                        : spotify.progressMs + 15000;
                    runBusy('seek', () => spotify.seek(to));
                }, 'np_seek', 3);

                // Transport Controls: shuffle, previous, play, next, repeat centred under the panel,
                // the heart at the right end. Toggles show their state with the blue edge and icon.
                // (sized for this display: sz)
                const bh = sz(cv, 42), iconSz = sz(cv, 19);
                const cy = 472 + npEx - bh / 2;
                const midX = 464;
                const iconCol = (on) => (on ? playingCol(t) : t.text);
                const toggle = (x, w, on, key, icon, run) => {
                    const y = cy - bh / 2, h = bh;
                    iconButton(cv, t, x, y, w, h, key, { on });
                    if (isBusy(key)) drawSpinner(cv, x + w / 2, cy, sz(cv, 8), on ? t.accent : t.dim);
                    else icon(x + w / 2, cy, G.isFocus(cv, key) ? '#ffffff' : iconCol(on));
                    cv.target(x, y, w, h, () => runBusy(key, run), key, 3, { own: true });
                };

                // 3. Play / Pause: the blue one
                const playW = sz(cv, 74), tBusy = isBusy('transport');
                iconButton(cv, t, midX - playW / 2, cy - bh / 2, playW, bh, 'np_play', { primary: true, busy: tBusy });
                if (busyOn('transport', 'play')) drawSpinner(cv, midX, cy, sz(cv, 10), '#ffffff', 4);
                else if (isPlaying) drawPauseIcon(cv, midX, cy, sz(cv, 20), '#ffffff');
                else drawPlayIcon(cv, midX + 2, cy, sz(cv, 20), '#ffffff');
                cv.target(midX - playW / 2, cy - bh / 2, playW, bh, () => {
                    runBusy('transport', () => spotify.togglePlay(), 'play');
                }, 'np_play', 3, { own: true });

                // 2. / 4. Previous, Next
                const skipW = sz(cv, 58), skipGap = sz(cv, 10);
                const prevX = midX - playW / 2 - skipGap - skipW, nextX = midX + playW / 2 + skipGap;
                [[prevX, 'np_prev', 'prev', drawPrevIcon, () => spotify.prevTrack()],
                 [nextX, 'np_next', 'next', drawNextIcon, () => spotify.nextTrack()]].forEach(([x, key, id, icon, run]) => {
                    iconButton(cv, t, x, cy - bh / 2, skipW, bh, key, { busy: tBusy });
                    if (busyOn('transport', id)) drawSpinner(cv, x + skipW / 2, cy, sz(cv, 8), t.text);
                    else icon(cv, x + skipW / 2, cy, iconSz, tBusy ? t.dim : t.text);
                    cv.target(x, cy - bh / 2, skipW, bh, () => runBusy('transport', run, id), key, 3, { own: true });
                });

                // 1. / 5. Shuffle, Repeat
                const togW = sz(cv, 54), togGap = sz(cv, 22);
                toggle(prevX - togGap - togW, togW, !!spotify.shuffle, 'np_shuffle',
                    (x, y, c) => drawShuffleIcon(cv, x, y, iconSz, c), () => spotify.toggleShuffle());
                const repMode = spotify.repeat;
                toggle(nextX + skipW + togGap, togW, !!(repMode && repMode !== 'off'), 'np_repeat',
                    (x, y, c) => drawRepeatIcon(cv, x, y, iconSz, c, repMode), () => spotify.toggleRepeat());

                // 6. Like: at the end of the progress bar's line
                const isLiked = !!spotify.isCurrentLiked;
                const likeX = 880 - togW;
                iconButton(cv, t, likeX, cy - bh / 2, togW, bh, 'np_like', { on: isLiked });
                if (isBusy('like')) drawSpinner(cv, likeX + togW / 2, cy, sz(cv, 8), isLiked ? t.accent : t.dim);
                else drawHeartIcon(cv, likeX + togW / 2, cy + 1, iconSz, G.isFocus(cv, 'np_like') ? '#ffffff' : iconCol(isLiked), isLiked);
                cv.target(likeX, cy - bh / 2, togW, bh, () => runBusy('like', () => spotify.toggleLikeCurrent()), 'np_like', 3, { own: true });
            }

            // Right Pane: Up Next in Queue (w: 656, h: 468)
            let upcoming = (spotify.remoteQueue && spotify.remoteQueue.length) ? spotify.remoteQueue : [];
            if (!upcoming.length && spotify.currentPlaylist && spotify.currentPlaylist.tracks) {
                const trks = spotify.currentPlaylist.tracks;
                const curIdx = trks.findIndex((x) => curTrk && x.id === curTrk.id);
                if (curIdx >= 0 && curIdx < trks.length - 1) {
                    upcoming = trks.slice(curIdx + 1);
                }
            } else if (!upcoming.length && spotify.likedSongs && spotify.likedSongs.length) {
                const curIdx = spotify.likedSongs.findIndex((x) => curTrk && x.id === curTrk.id);
                if (curIdx >= 0 && curIdx < spotify.likedSongs.length - 1) {
                    upcoming = spotify.likedSongs.slice(curIdx + 1);
                }
            }

            G.panel(cv, t, 920, 44, 656, 468, 'Up next  ·  ' + upcoming.length);

            if (!upcoming || upcoming.length === 0) {
                drawEmpty(cv, t, 1248, 200, 'The queue is empty', 'Play a song from Playlists or Liked Songs.');
                return;
            }

            const m = metrics(cv), qTop = m.listTop, qStep = m.songStep;
            const VISIBLE_Q = Math.max(1, Math.floor((498 + npEx - qTop + 6) / qStep));
            queueScroll = Math.max(0, Math.min(queueScroll, Math.max(0, upcoming.length - VISIBLE_Q)));
            listGeo.q = { x0: 920, x1: 1576, rowH: qStep, count: upcoming.length, visible: VISIBLE_Q };
            cv.scroll = true;
            const visibleQ = upcoming.slice(queueScroll, queueScroll + VISIBLE_Q);
            visibleQ.forEach((trk, idx) => {
                const qy = qTop + idx * qStep, startKey = 'q:' + trk.id, starting = busyOn('start', startKey);
                drawSongRow(cv, t, m, { x: 938, w: 620, y: qy, idx: queueScroll + idx, trk, playing: starting, starting, key: 'q_trk_' + (queueScroll + idx) });

                cv.target(938, qy, 620, qStep, () => {
                    // what plays now, from this song on (a song queued by hand: that song alone)
                    const pl = spotify.currentPlaylist;
                    const pIdx = !spotify.contextUri && pl && pl.tracks ? pl.tracks.findIndex((x) => x.id === trk.id) : -1;
                    if (pIdx >= 0) runBusy('start', () => spotify.playTrack(pl, pIdx), startKey);
                    else runBusy('start', () => spotify.playQueued(trk), startKey);
                }, 'q_trk_' + (queueScroll + idx), 3, { list: 'q', row: queueScroll + idx, step: qStep, own: true });
            });
        }

        /* ---------- Page 3: Connect & Real Cloud Pairing ---------- */
        function drawConnect(cv, t) {
            // Left: Real Cloud Pairing QR Code or Connected Status
            G.panelExact(cv, t, 24, 44, 580, metrics(cv).panelH, spotify.isAuthenticated() ? 'Spotify account' : 'Connect your phone');

            const authed = spotify.isAuthenticated();
            if (!authed) showPhoneQr = false;
            const cx = 314;
            if (authed && !showPhoneQr) {
                // connected: a check in a thin blue ring, as the HMI confirms a connection
                const by = 148;
                cv.arc(cx, by, 30, 32.5, 0, 360, t.accent);
                cv.polyline([[cx - 12, by + 1], [cx - 4, by + 9], [cx + 13, by - 9]], 3.5, playingCol(t));

                cv.text('Connected to Spotify', cx, 216, 24, t.text, { align: 'center', font: 'light' });
                const prof = spotify.profile;
                const plan = prof && prof.product ? prof.product.charAt(0).toUpperCase() + prof.product.slice(1) : '';
                cv.text(prof ? fitText(cv, prof.name + (plan ? '  -  ' + plan : ''), 480, 16) : 'Signed in', cx, 244, 16, t.dim, { align: 'center' });

                // where the music plays (the HMI's status line), or how to start
                const label = spotify.activeDevice ? fitText(cv, 'Playing on ' + spotify.activeDevice, 420, 15)
                    : 'No device playing - open Spotify on your phone';
                const lw = cv.textWidth(label, 15) + 22;
                G.status(cv, t, cx - lw / 2, 282, label, spotify.activeDevice ? (spotify.isPlaying ? t.accent : t.dim) : faint(t), 15);

                // the library at a glance
                const nPl = (spotify.playlists || []).length;
                const nLiked = spotify.likedTotal || (spotify.likedSongs || []).length;
                cv.text(nPl + ' playlist' + (nPl === 1 ? '' : 's') + '  ·  ' + nLiked + ' liked song' + (nLiked === 1 ? '' : 's'), cx, 310, 14, faint(t), { align: 'center' });

                // disconnecting or switching account is the phone's: the car follows it live. The
                // phone page's QR code puts this car on a phone again (a new phone, cleared browser)
                const qbW = 380, qbX = cx - qbW / 2, qbH = Math.min(56, sz(cv, 36)), qbY = 380 - qbH;
                drawButton(cv, t, qbX, qbY, qbW, qbH, 'Show QR for the phone page', 'btn_phone_qr', () => { showPhoneQr = true; render().catch(() => {}); }, { chevron: true });
                cv.text('Disconnect or switch account on your phone.', cx, 404, 13, faint(t), { align: 'center' });
            } else {
                // Real Cloud Pairing QR Code
                const qrx = 224, qry = 100, qrsz = 180;
                const qr = getQrMatrix();
                if (qr) {
                    const modCount = qr.size;
                    const modPx = Math.floor(qrsz / modCount);
                    const actualSz = modPx * modCount;
                    const ox = qrx + Math.floor((qrsz - actualSz) / 2);
                    const oy = qry + Math.floor((qrsz - actualSz) / 2);

                    // White backdrop for clean camera scanning
                    cv.roundRect(ox - 10, oy - 10, actualSz + 20, actualSz + 20, 3, '#ffffff');
                    // drawn once as a layer (kit gauges.qrCode), not a rectangle per module every frame
                    G.qrCode(cv, qr, cachedQrUrl, ox, oy, modPx);
                }

                cv.text(authed ? 'Scan to open this car on your phone' : 'Scan with your phone to connect Spotify', cx, 322, 17, t.text, { align: 'center' });
                const code = 'Pairing code  ' + cloudPair.getShortCode();
                cv.text(code, cx, 346, 14, playingCol(t), { align: 'center', font: 'num' });
                // paired: the phone that scans it may have the app installed; the camera opens the
                // browser, and on iPhone the Home Screen app keeps its own cars
                if (authed) cv.text('Installed the phone app? Scan with its Scan car QR, not the camera.', cx, 366, 12, faint(t), { align: 'center' });
                else cv.text('hexlay.github.io/idrive7-custom-apps/pair.html', cx, 366, 12, faint(t), { align: 'center' });
                if (authed) {
                    const bbW = 380, bbX = cx - bbW / 2, bbY = 384, bbH = Math.min(52, sz(cv, 34));
                    drawButton(cv, t, bbX, bbY, bbW, bbH, 'Back to the account', 'btn_phone_qr_back', () => { showPhoneQr = false; render().catch(() => {}); });
                }
            }

            // Right: Spotify Connect Target Devices
            G.panelExact(cv, t, 620, 44, 956, metrics(cv).panelH, 'Spotify Connect devices');
            const devices = spotify.getDevices();

            if (!devices || devices.length === 0) {
                G.infoSign(cv, t, 680, 150, 22);
                cv.text('No Spotify devices found', 724, 146, 20, t.text, { font: 'light' });
                cv.text('Open Spotify on your phone, computer or speaker to play through it.', 724, 176, 15, t.dim);
                cv.text('Spotify Connect plays on a device that runs Spotify.', 724, 200, 13, faint(t));

                // Refresh Button
                const devBusy = isBusy('devices');
                drawButton(cv, t, 724, 228, sz(cv, 170), sz(cv, 34), devBusy ? 'Searching...' : 'Refresh devices', 'btn_refresh_devs', () => {
                    runBusy('devices', () => spotify.fetchDevices());
                }, { busy: devBusy, spin: devBusy });
            } else {
                // as many as the panel holds; the one that plays first
                // (sized for this display: sz)
                const m = metrics(cv), rowH = m.songStep, step = rowH, devTop = m.listTop;
                const DEV_ROWS = Math.max(1, Math.floor((m.listBottom - devTop + 6) / step));
                const nSize = m.title, sSize = m.meta;
                const shown = devices.slice().sort((x, y) => (y.isActive ? 1 : 0) - (x.isActive ? 1 : 0)).slice(0, DEV_ROWS);
                shown.forEach((dev, idx) => {
                    const dy = devTop + idx * step, mid = dy + rowH / 2;
                    const isCur = !!dev.isActive;
                    const moving = busyOn('transfer', dev.id);
                    const dkey = 'dev_' + idx, dfocus = G.isFocus(cv, dkey);
                    G.listRow(cv, t, 644, dy, 908, rowH, { active: isCur, focus: dfocus });

                    // the device's kind, as a line glyph
                    const iconX = 644 + 34;
                    drawDeviceIcon(cv, iconX, mid, dev.type, dfocus ? '#ffffff' : isCur ? playingCol(t) : t.dim);

                    // the action: where it plays, or "play here"
                    const bw = sz(cv, 110), bh = sz(cv, 32), bx = 644 + 908 - 16 - bw, by = mid - bh / 2;
                    const textX = iconX + 36;
                    cv.text(fitText(cv, dev.name, bx - 20 - textX, nSize, ROW), textX, dy + rowH * 0.47, nSize, t.text, ROW);
                    const vol = typeof dev.volume === 'number' ? '  ·  Volume ' + dev.volume + '%' : '';
                    cv.text(fitText(cv, (isCur ? (spotify.isPlaying ? 'Playing now' : 'Paused here') : dev.type) + vol, bx - 20 - textX, sSize, SUB), textX, dy + rowH * 0.8, sSize, dfocus ? withAlpha('#ffffff', 0.8) : isCur ? playingCol(t) : t.dim, SUB);
                    if (isCur) {
                        const s = sz(cv, 12.5), lw = cv.textWidth('Active', s) + 22;
                        G.status(cv, t, bx + bw - lw, mid + s * 0.36, 'Active', t.accent, s);
                    } else if (moving) {
                        drawSpinner(cv, bx + bw / 2, mid, sz(cv, 8), t.accent);
                    } else {
                        drawButton(cv, t, bx, by, bw, bh, 'Play here', null, null, { busy: isBusy('transfer') });
                    }

                    cv.target(644, dy, 908, rowH, () => {
                        if (!isCur) runBusy('transfer', () => spotify.transferToDevice(dev.id), dev.id);
                    }, dkey, 3, { list: 'dev', row: idx, step: rowH, own: true });
                });
            }

            // Bottom Player Dock
            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Master Render Loop ---------- */
        // What a frame shows, roughly: the loop draws again when it changes, or at least once a second
        // (data that isn't listed here then shows within a second). Taps, scrolling, the album art and
        // the pairing call render() themselves and always draw.
        function frameSig() {
            const trk = spotify.currentTrack, pl = spotify.currentPlaylist, n = spotify.notice;
            return [page, ctx.display && ctx.display.focusKey, showPhoneQr, selectedPlaylistIdx, playlistScroll, trackScroll, likedScroll, queueScroll,
                settings.get('theme'), settings.get('demo'), spotify.hasInternet, spotify.isAuthenticated(),
                trk ? trk.id : '', spotify.isPlaying, spotify.stalled, spotify.shuffle, spotify.repeat, spotify.isCurrentLiked,
                Math.floor((spotify.progressMs || 0) / 1000), spotify.contextUri, spotify.activeDevice,
                (spotify.playlists || []).length, pl ? pl.id + ':' + ((pl.tracks && pl.tracks.length) || 0) : '',
                (spotify.likedSongs || []).length, spotify.likedTotal, (spotify.remoteQueue || []).length,
                (spotify.devices || []).map((d) => d.id + (d.isActive ? '*' : '')).join(','),
                artManager.hasArt, artManager.currentUrl, n && Date.now() - n.at <= NOTICE_MS ? n.text : ''].join('|');
        }
        let lastSig = '', lastDrawAt = 0;
        /** The loop's frame: drawn while something moves (music, a spinner), on a change, or once a second. */
        function loopFrame() {
            const moving = spotify.isPlaying || Object.keys(busy).some(isBusy) || spotify.isLoadingPlaylists || spotify.isLoadingLiked;
            if (!moving && Date.now() - lastDrawAt < 1000) {
                spotify.tick();                 // the polls go on
                if (frameSig() === lastSig) return Promise.resolve();
            }
            return render();
        }

        async function render() {
            spotify.tick();
            spectrumSeed += 0.08;
            lastSig = frameSig();
            lastDrawAt = Date.now();

            if (spotify.currentTrack && spotify.currentTrack.albumArt) {
                artManager.load(spotify.currentTrack.albumArt);
            } else if (artManager.hasArt) {
                artManager.load(null);           // nothing playing: no leftover album art
            }

            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            G.background(cv, t, 0, 0, W, H + (cv.extra || 0));

            const isOnline = settings.get('demo') !== 'on';

            // 1. Connection check: In Online mode, if there is no internet, disable app
            if (isOnline && !spotify.hasInternet) {
                drawNoInternet(cv, t);
                G.frame(cv, t, PAGES, page, [{ text: 'No internet', color: t.crit }]);
                await ui.image('MAIN_GFX', cv);
                return;
            }

            // 2. Authentication check: In Online mode, if unauthenticated, force Connect or Gating
            if (isOnline && !spotify.isAuthenticated()) {
                if (page === 3) {
                    drawConnect(cv, t);
                } else {
                    drawRequireConnect(cv, t);
                }
                G.frame(cv, t, PAGES, page, [{ text: 'Login required', color: t.warn }]);
                await ui.image('MAIN_GFX', cv);
                return;
            }

            // Normal Playback / Browsing screens
            if (page === 0) drawPlaylists(cv, t);
            else if (page === 1) drawLibrary(cv, t);
            else if (page === 2) drawNowPlaying(cv, t);
            else if (page === 3) drawConnect(cv, t);

            // the page tabs along the top and the HMI-style status line: where it plays, and whether it plays
            G.frame(cv, t, PAGES, page, [
                spotify.stalled
                    ? { text: (spotify.activeDevice ? trunc(spotify.activeDevice, 24) + ' not responding' : 'Not responding'), color: t.warn }
                    : { text: spotify.activeDevice ? trunc(spotify.activeDevice, 28) : (spotify.isPlaying ? 'Playing' : 'Paused'), color: spotify.isPlaying ? t.accent : t.dim }
            ]);

            drawNotice(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        /* What went wrong, for NOTICE_MS over the dock: a tap closes it sooner. */
        const NOTICE_MS = 5000;
        function drawNotice(cv, t) {
            const n = spotify.notice;
            if (!n || Date.now() - n.at > NOTICE_MS) return;
            const size = 16, opts = { font: 'label' };
            // over the dock's top edge; on Now Playing (no dock, the controls at the bottom) over Up Next
            const onNp = page === 2;
            const cx = onNp ? 1248 : 800, maxW = onNp ? 540 : 1100;
            const text = fitText(cv, n.text, maxW, size, opts);
            const w = cv.textWidth(text, size, opts) + 84, h = 50;
            const x = Math.round(cx - w / 2), y = 446 + (cv.extra || 0) - h - (onNp ? -40 : 12);
            // the HMI's message box: dark, a hairline edge, its warning sign
            cv.roundRect(x, y, w, h, 4, '#161c23');
            cv.strokeRoundRect(x, y, w, h, 4, 1, withAlpha('#ffffff', 0.22));
            cv.fillRect(x, y + 8, 3, h - 16, t.warn);
            G.infoSign(cv, t, x + 32, y + h / 2, 12, true);
            cv.text(text, x + 56, y + h / 2 + 6, size, t.text, opts);
            cv.target(x, y, w, h, () => { spotify.notice = null; render(); }, 'notice', 3);
            // over the list rows: a tap on it is its own (the first target under a finger wins)
            if (Array.isArray(cv.targets)) cv.targets.unshift(cv.targets.pop());
        }

        /* ---------- HMI Button & Touch Interactions ---------- */
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ctx.onTab((idx) => { page = idx; showPhoneQr = false; return render(); });

        // 30 fps while music plays (spectrum, progress), 10 fps otherwise - and an unchanged frame
        // isn't drawn again (loopFrame); taps redraw at once
        ctx.loop('MAIN', 15, loopFrame, { maxFps: () => (spotify.isPlaying ? 30 : 10) });
        // where the frame goes changed (renderer, layout): draw it again there
        if (ctx.onLayout) ctx.onLayout(() => { render().catch(() => {}); });
        await render();
        log.info('Spotify app ready');
    }
});
