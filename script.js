/**
 * SpeedCheck — script.js
 * Uses the Cloudflare Speed Test API (speed.cloudflare.com)
 * This is a real, browser-based speed test with no backend required.
 *
 * How it works:
 * - Ping: Measures round-trip time to Cloudflare's CDN endpoints via fetch()
 * - Download: Fetches large files from Cloudflare CDN and measures throughput
 * - Upload: POSTs data to Cloudflare's speed test endpoint and measures throughput
 */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  results: { ping: null, download: null, upload: null },
  running: false,
};

// ─── DOM ─────────────────────────────────────────────────────────────────────
const screens = {
  idle:    document.getElementById('screen-idle'),
  testing: document.getElementById('screen-testing'),
  results: document.getElementById('screen-results'),
  offline: document.getElementById('screen-offline'),
};

const el = {
  startBtn:         document.getElementById('start-btn'),
  retestBtn:        document.getElementById('retest-btn'),
  shareBtn:         document.getElementById('share-btn'),
  retryOfflineBtn:  document.getElementById('retry-offline-btn'),
  installBtn:       document.getElementById('pwa-install-btn'),

  phaseText:        document.getElementById('phase-text'),
  liveSpeed:        document.getElementById('live-speed'),
  liveUnit:         document.getElementById('live-unit'),
  livePing:         document.getElementById('live-ping'),
  liveDownload:     document.getElementById('live-download'),
  liveUpload:       document.getElementById('live-upload'),
  progressFill:     document.getElementById('progress-fill'),
  progressLabel:    document.getElementById('progress-label'),
  gaugeArc:         document.getElementById('gauge-arc'),

  rPing:            document.getElementById('r-ping'),
  rDownload:        document.getElementById('r-download'),
  rUpload:          document.getElementById('r-upload'),
  rPingRating:      document.getElementById('r-ping-rating'),
  rDownloadRating:  document.getElementById('r-download-rating'),
  rUploadRating:    document.getElementById('r-upload-rating'),
  rTimestamp:       document.getElementById('result-timestamp'),
  rSummary:         document.getElementById('result-summary'),
};

// ─── Cloudflare Speed Test Endpoints ─────────────────────────────────────────
// Using Cloudflare's public CDN. These URLs are the same ones used by
// speed.cloudflare.com — fully public, no auth required.
const CF = {
  // Different size payloads for download testing
  download: [
    { url: 'https://speed.cloudflare.com/__down?bytes=102400',    size: 102400    },  // 100 KB
    { url: 'https://speed.cloudflare.com/__down?bytes=1048576',   size: 1048576   },  // 1 MB
    { url: 'https://speed.cloudflare.com/__down?bytes=10485760',  size: 10485760  },  // 10 MB
    { url: 'https://speed.cloudflare.com/__down?bytes=25000000',  size: 25000000  },  // 25 MB
  ],
  upload: 'https://speed.cloudflare.com/__up',
  meta: 'https://speed.cloudflare.com/meta',
};

// ─── Screen Management ────────────────────────────────────────────────────────
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle('active', key === name);
  });
}

// ─── Gauge ───────────────────────────────────────────────────────────────────
// The gauge SVG arc path is 283 units around (semicircle perimeter)
const GAUGE_LENGTH = 283;

function setGauge(mbps) {
  const maxMbps = 1000;
  const ratio = Math.min(mbps / maxMbps, 1);
  const offset = GAUGE_LENGTH * (1 - ratio);
  el.gaugeArc.style.strokeDashoffset = offset;

  // Color shift: blue → teal → green based on speed
  if (ratio < 0.3) {
    el.gaugeArc.style.stroke = '#4f8eff';
  } else if (ratio < 0.7) {
    el.gaugeArc.style.stroke = '#00c4ff';
  } else {
    el.gaugeArc.style.stroke = '#00e5c0';
  }
}

function resetGauge() {
  el.gaugeArc.style.strokeDashoffset = GAUGE_LENGTH;
  el.gaugeArc.style.stroke = '#4f8eff';
}

// ─── Live display updates ────────────────────────────────────────────────────
function setLiveSpeed(mbps) {
  el.liveSpeed.textContent = mbps > 0 ? mbps.toFixed(1) : '0';
  setGauge(mbps);
}

function setProgress(pct, label) {
  el.progressFill.style.width = `${Math.min(pct, 100)}%`;
  el.progressLabel.textContent = label;
}

function setPhase(text) {
  el.phaseText.textContent = text;
}

// ─── Measurement Helpers ──────────────────────────────────────────────────────

/**
 * Measure single ping via fetch
 * Returns round-trip time in ms
 */
async function measurePing() {
  const url = `${CF.download[0].url}&_=${Date.now()}`;
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) throw new Error('ping failed');
    return performance.now() - t0;
  } catch {
    // fallback: measure download of smallest file
    const t0b = performance.now();
    await fetch(`${CF.download[0].url}&_=${Date.now()}`, { cache: 'no-store' });
    return performance.now() - t0b;
  }
}

/**
 * Measure download speed for a given URL/size
 * Returns speed in Mbps
 */
async function measureDownload(url, bytes, onProgress) {
  const t0 = performance.now();

  const resp = await fetch(`${url}&_=${Date.now()}`, { cache: 'no-store' });
  if (!resp.ok || !resp.body) throw new Error('Download failed');

  const reader = resp.body.getReader();
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    const elapsed = (performance.now() - t0) / 1000;
    if (elapsed > 0 && onProgress) {
      const mbps = (received * 8) / (elapsed * 1_000_000);
      onProgress(mbps);
    }
  }

  const elapsed = (performance.now() - t0) / 1000;
  return (received * 8) / (elapsed * 1_000_000); // Mbps
}

/**
 * Measure upload speed
 * POSTs random data to Cloudflare's upload endpoint
 * Returns speed in Mbps
 */
async function measureUpload(bytes, onProgress) {
  // Create random data buffer
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data.subarray(0, Math.min(bytes, 65536)));
  // Fill rest with repeated pattern (faster than full random)
  for (let i = 65536; i < bytes; i++) data[i] = data[i % 65536];

  const blob = new Blob([data]);
  const t0 = performance.now();

  // Use XMLHttpRequest for upload progress events
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${CF.upload}?_=${Date.now()}`, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.loaded > 0) {
        const elapsed = (performance.now() - t0) / 1000;
        if (elapsed > 0 && onProgress) {
          const mbps = (e.loaded * 8) / (elapsed * 1_000_000);
          onProgress(mbps);
        }
      }
    };

    xhr.onload = () => {
      const elapsed = (performance.now() - t0) / 1000;
      const mbps = (bytes * 8) / (elapsed * 1_000_000);
      resolve(mbps);
    };

    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.ontimeout = () => reject(new Error('Upload timeout'));
    xhr.timeout = 30000;
    xhr.send(blob);
  });
}

// ─── Percentile / trimmed mean ────────────────────────────────────────────────
function trimmedMean(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  // Remove top 10% outliers
  const cut = Math.floor(sorted.length * 0.9);
  const trimmed = sorted.slice(0, cut + 1);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

// ─── Main Test Runner ─────────────────────────────────────────────────────────
async function runTest() {
  if (state.running) return;
  if (!navigator.onLine) { showScreen('offline'); return; }

  state.running = true;
  state.results = { ping: null, download: null, upload: null };

  showScreen('testing');
  resetGauge();
  setLiveSpeed(0);
  el.livePing.textContent = '—';
  el.liveDownload.textContent = '—';
  el.liveUpload.textContent = '—';
  el.liveUnit.textContent = 'Mbps';

  try {

    // ── PHASE 1: Ping ────────────────────────────────────────────────────────
    setPhase('Measuring Ping');
    setProgress(5, 'Measuring latency...');

    const pingResults = [];
    const PING_ROUNDS = 8;
    for (let i = 0; i < PING_ROUNDS; i++) {
      const ms = await measurePing();
      pingResults.push(ms);
      const avg = trimmedMean(pingResults);
      el.livePing.textContent = Math.round(avg);
      setProgress(5 + (i / PING_ROUNDS) * 20, `Ping round ${i+1}/${PING_ROUNDS}...`);
      await sleep(100);
    }

    state.results.ping = Math.round(trimmedMean(pingResults));
    el.livePing.textContent = state.results.ping;
    setProgress(25, 'Ping complete ✓');
    await sleep(300);

    // ── PHASE 2: Download ────────────────────────────────────────────────────
    setPhase('Download Speed');

    const dlSamples = [];
    let dlProgress = 25;

    // Test each size, pick largest that fits in ~10s total
    const dlSizes = CF.download;
    const perFileProgress = 60 / dlSizes.length;

    for (let i = 0; i < dlSizes.length; i++) {
      const { url, size } = dlSizes[i];
      const label = formatSize(size);
      setProgress(dlProgress, `Downloading ${label} file...`);

      try {
        let latestMbps = 0;
        const mbps = await measureDownload(url, size, (live) => {
          latestMbps = live;
          setLiveSpeed(live);
          el.liveDownload.textContent = live.toFixed(1);
        });

        dlSamples.push(mbps);
        dlProgress += perFileProgress;
        setProgress(dlProgress, `${label}: ${mbps.toFixed(1)} Mbps`);
        await sleep(150);

        // If we're on very fast connection and already got good sample, continue
      } catch (e) {
        console.warn('DL error for size', size, e);
      }
    }

    // Use 90th percentile of best samples
    const dlSorted = [...dlSamples].sort((a, b) => b - a);
    const dlFinal = dlSorted.slice(0, Math.max(1, Math.ceil(dlSorted.length * 0.6)));
    state.results.download = parseFloat(trimmedMean(dlFinal).toFixed(2));

    el.liveDownload.textContent = state.results.download;
    setLiveSpeed(state.results.download);
    setProgress(85, 'Download complete ✓');
    await sleep(400);

    // ── PHASE 3: Upload ──────────────────────────────────────────────────────
    setPhase('Upload Speed');

    // Adapt upload size based on download speed detected
    let uploadBytes;
    if (state.results.download > 200) uploadBytes = 25_000_000; // 25 MB
    else if (state.results.download > 50) uploadBytes = 10_000_000; // 10 MB
    else if (state.results.download > 10) uploadBytes = 5_000_000;  // 5 MB
    else uploadBytes = 1_000_000; // 1 MB

    setProgress(86, `Uploading ${formatSize(uploadBytes)}...`);
    setLiveSpeed(0);

    const ulSamples = [];

    // Run 2 upload passes
    for (let pass = 0; pass < 2; pass++) {
      try {
        const ulMbps = await measureUpload(uploadBytes, (live) => {
          setLiveSpeed(live);
          el.liveUpload.textContent = live.toFixed(1);
        });
        ulSamples.push(ulMbps);
        setProgress(86 + (pass + 1) * 6, `Upload pass ${pass+1} done`);
      } catch (e) {
        console.warn('Upload error', e);
      }
    }

    state.results.upload = ulSamples.length
      ? parseFloat(trimmedMean(ulSamples).toFixed(2))
      : 0;

    el.liveUpload.textContent = state.results.upload;
    setLiveSpeed(state.results.upload);
    setProgress(100, 'Test complete!');
    await sleep(600);

    // ── SHOW RESULTS ─────────────────────────────────────────────────────────
    showResults();

  } catch (err) {
    console.error('Speed test error:', err);
    if (!navigator.onLine) {
      showScreen('offline');
    } else {
      alert('Test failed. Check your connection and try again.\n\n' + err.message);
      showScreen('idle');
    }
  } finally {
    state.running = false;
  }
}

// ─── Results ──────────────────────────────────────────────────────────────────
function showResults() {
  const { ping, download, upload } = state.results;

  el.rPing.textContent     = ping ?? '—';
  el.rDownload.textContent = download ?? '—';
  el.rUpload.textContent   = upload ?? '—';

  // Ratings
  el.rPingRating.textContent    = rateLatency(ping);
  el.rDownloadRating.textContent = rateSpeed(download);
  el.rUploadRating.textContent   = rateSpeed(upload);

  styleRating(el.rPingRating,     ping,     'ping');
  styleRating(el.rDownloadRating, download, 'speed');
  styleRating(el.rUploadRating,   upload,   'speed');

  // Timestamp
  el.rTimestamp.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Summary
  el.rSummary.textContent = generateSummary(ping, download, upload);

  showScreen('results');
}

function rateLatency(ms) {
  if (ms === null) return '';
  if (ms < 20) return 'Excellent';
  if (ms < 50) return 'Great';
  if (ms < 100) return 'Good';
  if (ms < 150) return 'Fair';
  return 'Poor';
}

function rateSpeed(mbps) {
  if (mbps === null) return '';
  if (mbps >= 500) return 'Blazing Fast';
  if (mbps >= 200) return 'Excellent';
  if (mbps >= 100) return 'Very Fast';
  if (mbps >= 50)  return 'Fast';
  if (mbps >= 25)  return 'Good';
  if (mbps >= 10)  return 'Fair';
  if (mbps >= 5)   return 'Slow';
  return 'Very Slow';
}

function styleRating(el, value, type) {
  let tier = 'mid';
  if (type === 'ping') {
    if (value < 50) tier = 'good';
    else if (value > 150) tier = 'bad';
  } else {
    if (value >= 50) tier = 'good';
    else if (value < 10) tier = 'bad';
  }

  const colors = {
    good: { bg: 'rgba(0,229,192,0.12)', color: '#00e5c0', border: 'rgba(0,229,192,0.3)' },
    mid:  { bg: 'rgba(255,196,79,0.12)', color: '#ffc44f', border: 'rgba(255,196,79,0.3)' },
    bad:  { bg: 'rgba(255,107,79,0.12)', color: '#ff6b4f', border: 'rgba(255,107,79,0.3)' },
  };
  const { bg, color, border } = colors[tier];
  el.style.cssText = `background:${bg};color:${color};border:1px solid ${border};`;
}

function generateSummary(ping, dl, ul) {
  if (!dl) return 'Test results unavailable.';
  if (dl >= 200 && ping < 30) return '🚀 Outstanding connection! Ideal for gaming, 4K streaming, and video calls.';
  if (dl >= 100) return '✅ Excellent speed. Handles 4K streaming, gaming, and large downloads with ease.';
  if (dl >= 50)  return '👍 Great speed. Suitable for HD streaming, video calls, and smooth browsing.';
  if (dl >= 25)  return '🙂 Solid connection. Good for HD video and most everyday tasks.';
  if (dl >= 10)  return '😐 Adequate for basic browsing and SD streaming, but may struggle with HD.';
  return '⚠️ Slow connection detected. Consider contacting your ISP or checking for network issues.';
}

// ─── Share ────────────────────────────────────────────────────────────────────
async function shareResults() {
  const { ping, download, upload } = state.results;
  const text = `My internet speed:\n📶 Download: ${download} Mbps\n📡 Upload: ${upload} Mbps\n⏱ Ping: ${ping} ms\n\nTested with SpeedCheck`;

  if (navigator.share) {
    try { await navigator.share({ title: 'SpeedCheck Results', text }); return; }
    catch {}
  }
  // Fallback: copy to clipboard
  try {
    await navigator.clipboard.writeText(text);
    el.shareBtn.textContent = 'Copied!';
    setTimeout(() => (el.shareBtn.textContent = 'Share Results'), 2000);
  } catch {
    prompt('Copy your results:', text);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatSize(bytes) {
  if (bytes >= 1_000_000) return `${bytes / 1_000_000} MB`;
  if (bytes >= 1_000)     return `${bytes / 1_000} KB`;
  return `${bytes} B`;
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
el.startBtn.addEventListener('click', runTest);
el.retestBtn.addEventListener('click', () => { showScreen('idle'); });
el.shareBtn.addEventListener('click', shareResults);
el.retryOfflineBtn.addEventListener('click', () => {
  if (navigator.onLine) { showScreen('idle'); }
  else { el.retryOfflineBtn.textContent = 'Still offline...'; setTimeout(() => { el.retryOfflineBtn.textContent = 'Try Again'; }, 2000); }
});

window.addEventListener('online',  () => { if (screens.offline.classList.contains('active')) showScreen('idle'); });
window.addEventListener('offline', () => { if (state.running) { /* let it fail naturally */ } });

// ─── PWA: Service Worker ──────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then(reg => console.log('SW registered', reg.scope))
      .catch(err => console.warn('SW failed', err));
  });
}

// ─── PWA: Install Prompt ──────────────────────────────────────────────────────
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  el.installBtn.classList.remove('hidden');
});

el.installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') el.installBtn.classList.add('hidden');
  deferredPrompt = null;
});

window.addEventListener('appinstalled', () => {
  el.installBtn.classList.add('hidden');
  deferredPrompt = null;
});
