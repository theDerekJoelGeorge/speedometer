/**
 * GPS Speedometer — vanilla JS geolocation tracker
 * Session data lives in memory only; no persistence APIs.
 */

(function () {
  "use strict";

  // ── Constants ───────────────────────────────────────────────

  const MS_TO_KMH = 3.6;
  const MS_TO_MPH = 2.2369362921;
  const DISTANCE_THRESHOLD_M = 4;
  const WEAK_ACCURACY_M = 50;
  const SMOOTHING_ALPHA = 0.25;
  const ELAPSED_TICK_MS = 1000;
  const GAUGE_MAX_KMH = 110;
  const SPEED_MILESTONES = [60, 70, 80, 90, 100];

  const GEO_OPTIONS = {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15000,
  };

  const APP_STATE = {
    IDLE: "idle",
    REQUESTING: "requesting",
    TRACKING: "tracking",
    WEAK_GPS: "weak-gps",
    PERMISSION_DENIED: "permission-denied",
    UNSUPPORTED: "unsupported",
  };

  const SPEED_ZONE = {
    GREEN: "green",
    YELLOW: "yellow",
    RED: "red",
    NEUTRAL: "neutral",
  };

  // ── DOM refs ────────────────────────────────────────────────

  const dom = {
    app: document.getElementById("app"),
    statusLabel: document.getElementById("status-label"),
    speedValue: document.getElementById("speed-value"),
    speedUnit: document.getElementById("speed-unit"),
    speedNotice: document.getElementById("speed-notice"),
    speedEstimateBadge: document.getElementById("speed-estimate-badge"),
    gaugeFill: document.getElementById("gauge-fill"),
    headingNeedle: document.getElementById("heading-needle"),
    headingCompass: document.getElementById("heading-compass"),
    headingPill: document.getElementById("heading-pill"),
    metricMax: document.getElementById("metric-max"),
    metricDistance: document.getElementById("metric-distance"),
    metricElapsed: document.getElementById("metric-elapsed"),
    btnStart: document.getElementById("btn-start"),
    btnStop: document.getElementById("btn-stop"),
    themeToggle: document.getElementById("theme-toggle"),
    hudToggle: document.getElementById("hud-toggle"),
    messageSection: document.getElementById("message-section"),
    messageText: document.getElementById("message-text"),
    unitRadios: document.querySelectorAll('input[name="unit"]'),
  };

  // ── Session (in-memory only) ────────────────────────────────

  const session = {
    watchId: null,
    appState: APP_STATE.IDLE,
    unit: "kmh",
    hudMode: false,
    theme: "light",
    startTime: null,
    elapsedTimer: null,
    previousPosition: null,
    currentSpeedMs: null,
    smoothedSpeedMs: null,
    maxSpeedMs: 0,
    totalDistanceM: 0,
    heading: null,
    accuracy: null,
    isEstimatedSpeed: false,
    hasReceivedFix: false,
    speedZone: SPEED_ZONE.NEUTRAL,
    nearestMilestone: null,
  };

  // ── Helper: unit conversions ────────────────────────────────

  function msToKmh(ms) {
    return ms * MS_TO_KMH;
  }

  function msToMph(ms) {
    return ms * MS_TO_MPH;
  }

  function convertSpeed(ms, unit) {
    return unit === "mph" ? msToMph(ms) : msToKmh(ms);
  }

  function getSpeedKmh() {
    if (session.smoothedSpeedMs == null) return null;
    return msToKmh(session.smoothedSpeedMs);
  }

  function unitLabel(unit) {
    return unit === "mph" ? "MPH" : "KM/H";
  }

  // ── Helper: haversine distance (meters) ─────────────────────

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Helper: format elapsed time ─────────────────────────────

  function formatElapsedCompact(ms) {
    if (ms == null || ms < 0) return "--";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${totalSec}s`;
  }

  // ── Helper: speed smoothing ─────────────────────────────────

  function smoothSpeed(rawMs, previousSmoothed) {
    if (rawMs == null || !Number.isFinite(rawMs)) return previousSmoothed;
    if (previousSmoothed == null) return rawMs;
    return SMOOTHING_ALPHA * rawMs + (1 - SMOOTHING_ALPHA) * previousSmoothed;
  }

  function computeFallbackSpeed(prev, curr) {
    if (!prev || !curr) return null;
    const dt = (curr.timestamp - prev.timestamp) / 1000;
    if (dt <= 0.5) return null;
    const dist = haversine(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
    if (dist < DISTANCE_THRESHOLD_M) return 0;
    return dist / dt;
  }

  // ── Speed zone & notification logic ─────────────────────────

  function nearestMilestone(speedKmh) {
    if (speedKmh == null || !Number.isFinite(speedKmh)) return null;
    let nearest = SPEED_MILESTONES[0];
    let minDiff = Math.abs(speedKmh - nearest);
    for (const m of SPEED_MILESTONES) {
      const diff = Math.abs(speedKmh - m);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = m;
      }
    }
    return nearest;
  }

  function getSpeedZone(speedKmh) {
    if (speedKmh == null || !Number.isFinite(speedKmh)) {
      return { zone: SPEED_ZONE.NEUTRAL, milestone: null };
    }

    if (speedKmh < SPEED_MILESTONES[0] - 5) {
      return { zone: SPEED_ZONE.GREEN, milestone: SPEED_MILESTONES[0] };
    }

    const milestone = nearestMilestone(speedKmh);

    if (speedKmh >= milestone + 4) {
      return { zone: SPEED_ZONE.RED, milestone };
    }
    if (speedKmh >= milestone && speedKmh <= milestone + 2) {
      return { zone: SPEED_ZONE.YELLOW, milestone };
    }
    if (speedKmh <= milestone - 5) {
      return { zone: SPEED_ZONE.GREEN, milestone };
    }

    // Between milestone − 4 and milestone − 1, or milestone + 3
    if (speedKmh >= milestone - 4) {
      return { zone: SPEED_ZONE.YELLOW, milestone };
    }

    return { zone: SPEED_ZONE.GREEN, milestone };
  }

  function getSpeedNotice(speedKmh, zone, milestone) {
    if (speedKmh == null || !Number.isFinite(speedKmh)) return "";

    if (zone === SPEED_ZONE.RED) return "Slow down";
    if (zone === SPEED_ZONE.YELLOW) {
      return speedKmh >= milestone ? "Slow down" : "Maintain";
    }
    if (speedKmh <= milestone - 5) return "Maintain";
    return "Speed up";
  }

  // ── Helper: format display values ───────────────────────────

  function formatSpeed(ms) {
    if (ms == null || !Number.isFinite(ms)) return "--";
    return Math.round(convertSpeed(ms, session.unit)).toString();
  }

  function formatHeadingCompass(degrees) {
    if (degrees == null || !Number.isFinite(degrees)) return "--";
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(degrees / 45) % 8];
  }

  function formatDistanceCompact(meters, unit) {
    if (meters == null || !Number.isFinite(meters)) return "--";
    if (unit === "mph") {
      const miles = meters / 1609.344;
      if (miles < 0.1) return `${Math.round(meters * 3.28084)}ft`;
      return `${miles.toFixed(1)}MI`;
    }
    const km = meters / 1000;
    if (km < 0.1) return `${Math.round(meters)}M`;
    return `${km.toFixed(1)}KM`;
  }

  // ── State management ────────────────────────────────────────

  function setAppState(state) {
    session.appState = state;
    updateStatusUI();
    updateControlsUI();
  }

  function updateStatusUI() {
    const labels = {
      [APP_STATE.IDLE]: "Waiting for signal",
      [APP_STATE.REQUESTING]: "Requesting permission",
      [APP_STATE.TRACKING]: "Tracking",
      [APP_STATE.WEAK_GPS]: "Weak GPS",
      [APP_STATE.PERMISSION_DENIED]: "Permission denied",
      [APP_STATE.UNSUPPORTED]: "Not supported",
    };
    dom.statusLabel.textContent = labels[session.appState] || "Unknown";
  }

  function updateControlsUI() {
    const isActive =
      session.appState === APP_STATE.TRACKING ||
      session.appState === APP_STATE.WEAK_GPS ||
      session.appState === APP_STATE.REQUESTING;

    dom.btnStart.disabled = isActive;
    dom.btnStop.disabled = !isActive;
  }

  function showMessage(text) {
    if (!text) {
      dom.messageSection.classList.add("hidden");
      dom.messageText.textContent = "";
      return;
    }
    dom.messageText.textContent = text;
    dom.messageSection.classList.remove("hidden");
  }

  function hideMessage() {
    showMessage("");
  }

  // ── UI rendering ────────────────────────────────────────────

  function applyZoneClasses(el, zone) {
    el.classList.remove("zone-green", "zone-yellow", "zone-red", "zone-neutral");
    if (zone === SPEED_ZONE.GREEN) el.classList.add("zone-green");
    else if (zone === SPEED_ZONE.YELLOW) el.classList.add("zone-yellow");
    else if (zone === SPEED_ZONE.RED) el.classList.add("zone-red");
    else el.classList.add("zone-neutral");
  }

  function updateGauge(speedKmh, zone) {
    const fill = Math.min(Math.max(speedKmh ?? 0, 0), GAUGE_MAX_KMH);
    dom.gaugeFill.setAttribute("stroke-dasharray", `${fill} ${GAUGE_MAX_KMH}`);
    applyZoneClasses(dom.gaugeFill, zone);
  }

  function renderSpeed() {
    const hasSpeed = session.hasReceivedFix && session.smoothedSpeedMs != null;
    const speedKmh = getSpeedKmh();
    const { zone, milestone } = hasSpeed
      ? getSpeedZone(speedKmh)
      : { zone: SPEED_ZONE.NEUTRAL, milestone: null };

    session.speedZone = zone;
    session.nearestMilestone = milestone;

    dom.speedValue.textContent = hasSpeed ? formatSpeed(session.smoothedSpeedMs) : "--";
    dom.speedUnit.textContent = unitLabel(session.unit);
    applyZoneClasses(dom.speedValue, zone);
    updateGauge(speedKmh ?? 0, zone);

    const notice = hasSpeed ? getSpeedNotice(speedKmh, zone, milestone) : "";
    dom.speedNotice.textContent = notice;
    dom.speedNotice.classList.remove("notice-green", "notice-yellow", "notice-red", "hidden");
    if (notice) {
      dom.speedNotice.classList.add(`notice-${zone}`);
    } else {
      dom.speedNotice.classList.add("hidden");
    }

    if (session.isEstimatedSpeed && session.hasReceivedFix) {
      dom.speedEstimateBadge.classList.remove("hidden");
    } else {
      dom.speedEstimateBadge.classList.add("hidden");
    }
  }

  function renderHeading() {
    const label = formatHeadingCompass(session.heading);
    dom.headingCompass.textContent = label;

    if (session.heading != null && Number.isFinite(session.heading)) {
      const deg = session.heading;
      dom.headingNeedle.setAttribute("transform", `rotate(${deg} 12 12)`);
      dom.headingPill.setAttribute(
        "aria-label",
        `Current heading ${Math.round(deg)} degrees ${label}`
      );
    } else {
      dom.headingNeedle.setAttribute("transform", "rotate(0 12 12)");
      dom.headingPill.setAttribute("aria-label", "Current heading unknown");
    }
  }

  function renderMetrics() {
    renderHeading();

    dom.metricMax.textContent = session.hasReceivedFix
      ? formatSpeed(session.maxSpeedMs)
      : "--";

    dom.metricDistance.textContent = session.hasReceivedFix
      ? formatDistanceCompact(session.totalDistanceM, session.unit)
      : "--";

    dom.metricElapsed.textContent = session.startTime
      ? formatElapsedCompact(Date.now() - session.startTime)
      : "--";
  }

  function renderAll() {
    renderSpeed();
    renderMetrics();
  }

  // ── Session reset ───────────────────────────────────────────

  function resetSessionData() {
    session.previousPosition = null;
    session.currentSpeedMs = null;
    session.smoothedSpeedMs = null;
    session.maxSpeedMs = 0;
    session.totalDistanceM = 0;
    session.heading = null;
    session.accuracy = null;
    session.isEstimatedSpeed = false;
    session.hasReceivedFix = false;
    session.speedZone = SPEED_ZONE.NEUTRAL;
    session.nearestMilestone = null;
    session.startTime = null;
    stopElapsedTimer();
  }

  function stopElapsedTimer() {
    if (session.elapsedTimer) {
      clearInterval(session.elapsedTimer);
      session.elapsedTimer = null;
    }
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    session.elapsedTimer = setInterval(() => {
      if (session.startTime) renderMetrics();
    }, ELAPSED_TICK_MS);
  }

  // ── Geolocation handlers ────────────────────────────────────

  function normalizePosition(coords, timestamp) {
    return {
      latitude: coords.latitude,
      longitude: coords.longitude,
      speed: coords.speed,
      heading: coords.heading,
      accuracy: coords.accuracy,
      timestamp: timestamp ?? Date.now(),
    };
  }

  function accumulateDistance(prev, curr) {
    const segment = haversine(
      prev.latitude,
      prev.longitude,
      curr.latitude,
      curr.longitude
    );
    if (segment >= DISTANCE_THRESHOLD_M) {
      session.totalDistanceM += segment;
    }
  }

  function onPositionSuccess(rawPosition) {
    hideMessage();
    session.hasReceivedFix = true;

    const pos = normalizePosition(rawPosition.coords, rawPosition.timestamp);
    session.accuracy = pos.accuracy;
    session.heading = pos.heading;

    let rawSpeedMs = pos.speed;
    session.isEstimatedSpeed = false;

    if (rawSpeedMs == null || !Number.isFinite(rawSpeedMs)) {
      rawSpeedMs = computeFallbackSpeed(session.previousPosition, pos);
      session.isEstimatedSpeed = rawSpeedMs != null;
    }

    if (rawSpeedMs != null && Number.isFinite(rawSpeedMs)) {
      session.currentSpeedMs = Math.max(0, rawSpeedMs);
      session.smoothedSpeedMs = smoothSpeed(session.currentSpeedMs, session.smoothedSpeedMs);
      if (session.smoothedSpeedMs > session.maxSpeedMs) {
        session.maxSpeedMs = session.smoothedSpeedMs;
      }
    }

    if (session.previousPosition) {
      accumulateDistance(session.previousPosition, pos);
    }

    session.previousPosition = pos;

    const isWeak = pos.accuracy != null && pos.accuracy > WEAK_ACCURACY_M;
    setAppState(isWeak ? APP_STATE.WEAK_GPS : APP_STATE.TRACKING);
    renderAll();
  }

  function onPositionError(error) {
    if (error.code === error.PERMISSION_DENIED) {
      setAppState(APP_STATE.PERMISSION_DENIED);
      showMessage(
        "Location access was denied. Enable location permission for this site in your browser settings, then tap Start trip again."
      );
      stopTracking();
      return;
    }

    if (error.code === error.TIMEOUT) {
      setAppState(APP_STATE.WEAK_GPS);
      showMessage("GPS signal timed out. Move to an open area for a clearer view of the sky.");
      return;
    }

    setAppState(APP_STATE.WEAK_GPS);
    showMessage("Unable to get a GPS fix. Check that location services are enabled on your device.");
  }

  // ── Tracking control ────────────────────────────────────────

  function startTracking() {
    if (!navigator.geolocation) {
      setAppState(APP_STATE.UNSUPPORTED);
      showMessage(
        "Your browser does not support the Geolocation API. Try a modern mobile browser such as Chrome or Safari."
      );
      return;
    }

    resetSessionData();
    session.startTime = Date.now();
    startElapsedTimer();
    hideMessage();
    setAppState(APP_STATE.REQUESTING);
    renderAll();

    session.watchId = navigator.geolocation.watchPosition(
      onPositionSuccess,
      onPositionError,
      GEO_OPTIONS
    );
  }

  function stopTracking() {
    if (session.watchId != null) {
      navigator.geolocation.clearWatch(session.watchId);
      session.watchId = null;
    }
    stopElapsedTimer();
    setAppState(APP_STATE.IDLE);
    renderAll();
  }

  // ── Theme & HUD ─────────────────────────────────────────────

  function setTheme(theme) {
    session.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      theme === "dark" ? "#0a0e14" : "#ffffff"
    );
    dom.themeToggle.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
    );
  }

  function toggleTheme() {
    setTheme(session.theme === "dark" ? "light" : "dark");
  }

  function toggleHud() {
    session.hudMode = !session.hudMode;
    dom.app.classList.toggle("is-hud", session.hudMode);
    dom.hudToggle.setAttribute("aria-pressed", String(session.hudMode));
    dom.hudToggle.setAttribute(
      "aria-label",
      session.hudMode ? "Disable HUD mode" : "Enable HUD mode"
    );
  }

  function onUnitChange(unit) {
    session.unit = unit;
    renderAll();
  }

  // ── Event bindings ──────────────────────────────────────────

  function bindEvents() {
    dom.btnStart.addEventListener("click", startTracking);
    dom.btnStop.addEventListener("click", stopTracking);
    dom.themeToggle.addEventListener("click", toggleTheme);
    dom.hudToggle.addEventListener("click", toggleHud);

    dom.unitRadios.forEach((radio) => {
      radio.addEventListener("change", (e) => {
        if (e.target.checked) onUnitChange(e.target.value);
      });
    });
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  // ── Init ────────────────────────────────────────────────────

  function init() {
    if (!navigator.geolocation) {
      setAppState(APP_STATE.UNSUPPORTED);
      showMessage(
        "Your browser does not support the Geolocation API. Try a modern mobile browser such as Chrome or Safari."
      );
      dom.btnStart.disabled = true;
    }

    bindEvents();
    updateStatusUI();
    updateControlsUI();
    renderAll();
    registerServiceWorker();
  }

  init();
})();
