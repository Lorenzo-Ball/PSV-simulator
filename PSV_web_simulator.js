(function () {
  "use strict";

  const curveDefs = {
    paw: { title: "Paw", unit: "cmH2O", color: "#c8102e", defaults: [-15, 35], pad: 2 },
    flow: { title: "Flow", unit: "L/s", color: "#002677", defaults: [-1.5, 2.5], pad: 0.2 },
    volume: { title: "Volume rel. FRC", unit: "L", color: "#27734f", defaults: [0, 1.5], pad: 0.1 },
    pes: { title: "Pes", unit: "cmH2O", color: "#199bfc", defaults: [-35, 2], pad: 2 },
    pmus: { title: "Pmus eq.", unit: "cmH2O", color: "#c9651d", defaults: [-35, 2], pad: 2 },
    state: { title: "Ventilator state", unit: "EXP  INSP  OCC", color: "#25282a", defaults: [-0.2, 2.2], pad: 0 }
  };

  const curveOrder = ["paw", "flow", "volume", "pes", "pmus", "state"];

  let params = defaultParams();
  let sim = defaultSim();
  let curves = { paw: true, flow: true, volume: false, pes: true, pmus: false, state: false };
  let latestSnapshot = null;
  let worker = null;
  let plotCanvases = new Map();

  const el = {
    plotStack: document.getElementById("plotStack"),
    runStatus: document.getElementById("runStatus"),
    eventLog: document.getElementById("eventLog"),
    maneuverStatus: document.getElementById("maneuverStatus")
  };

  init();

  function init() {
    worker = createWorker();
    wireTabs();
    wireControls();
    wireButtons();
    syncControls();
    buildPlotStack();
    worker.postMessage({ type: "init", params, sim });
    requestAnimationFrame(animationLoop);
  }

  function createWorker() {
    const blob = new Blob([workerSource()], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    w.onmessage = function (event) {
      const msg = event.data;
      if (msg.type === "snapshot") {
        latestSnapshot = msg.snapshot;
        updateReadouts(msg.snapshot);
      }
    };
    return w;
  }

  function wireTabs() {
    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        const name = button.dataset.tab;
        document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === button));
        document.querySelectorAll(".tab-page").forEach((page) => {
          page.classList.toggle("active", page.dataset.page === name);
        });
      });
    });
  }

  function wireControls() {
    document.querySelectorAll("[data-path]").forEach((control) => {
      const path = control.dataset.path;
      const handler = () => {
        let value;
        if (control.type === "checkbox") {
          value = control.checked;
        } else if (control.tagName === "SELECT") {
          value = control.value;
        } else {
          value = Number(control.value);
        }

        setPath(params, path, value);

        if (path === "effort.strength") {
          if (value === "Weak") params.effort.deltaPes = 4;
          if (value === "Normal") params.effort.deltaPes = 8;
          if (value === "Strong") params.effort.deltaPes = 18;
          syncControls();
          worker.postMessage({ type: "setParams", params });
          return;
        }

        updateOutput(control);
        worker.postMessage({ type: "setParam", path, value });
      };

      control.addEventListener("input", handler);
      control.addEventListener("change", handler);
    });

    document.querySelectorAll("[data-sim]").forEach((control) => {
      const key = control.dataset.sim;
      const handler = () => {
        sim[key] = Number(control.value);
        updateOutput(control);
        worker.postMessage({ type: "setSim", sim });
      };
      control.addEventListener("input", handler);
      control.addEventListener("change", handler);
    });

    document.querySelectorAll("[data-curve]").forEach((control) => {
      const key = control.dataset.curve;
      control.addEventListener("change", () => {
        curves[key] = control.checked;
        if (!activeCurves().length) {
          curves.paw = true;
          const pawToggle = document.querySelector('[data-curve="paw"]');
          if (pawToggle) pawToggle.checked = true;
        }
        buildPlotStack();
      });
    });
  }

  function wireButtons() {
    document.getElementById("startBtn").addEventListener("click", () => {
      worker.postMessage({ type: "start" });
    });

    document.getElementById("pauseBtn").addEventListener("click", () => {
      worker.postMessage({ type: "pause" });
    });

    document.getElementById("resetBtn").addEventListener("click", () => {
      worker.postMessage({ type: "reset", params, sim });
    });

    document.getElementById("exportBtn").addEventListener("click", exportCsv);

    document.querySelectorAll("[data-maneuver]").forEach((button) => {
      button.addEventListener("click", () => {
        worker.postMessage({ type: "maneuver", maneuver: button.dataset.maneuver });
      });
    });

    document.querySelectorAll("[data-preset]").forEach((button) => {
      button.addEventListener("click", () => {
        params = presetParams(button.dataset.preset);
        syncControls();
        worker.postMessage({ type: "preset", name: button.dataset.preset, params, sim });
      });
    });
  }

  function syncControls() {
    document.querySelectorAll("[data-path]").forEach((control) => {
      const value = getPath(params, control.dataset.path);
      if (control.type === "checkbox") {
        control.checked = Boolean(value);
      } else {
        control.value = value;
      }
      updateOutput(control);
    });

    document.querySelectorAll("[data-sim]").forEach((control) => {
      control.value = sim[control.dataset.sim];
      updateOutput(control);
    });

    document.querySelectorAll("[data-curve]").forEach((control) => {
      control.checked = Boolean(curves[control.dataset.curve]);
    });
  }

  function updateOutput(control) {
    const output = control.parentElement.querySelector("output");
    if (!output) return;
    output.textContent = formatValue(Number(control.value), control.dataset.format || "%.1f");
  }

  function buildPlotStack() {
    el.plotStack.innerHTML = "";
    plotCanvases = new Map();
    activeCurves().forEach((key) => {
      const strip = document.createElement("div");
      strip.className = "plot-strip";
      strip.dataset.curve = key;
      const canvas = document.createElement("canvas");
      strip.appendChild(canvas);
      el.plotStack.appendChild(strip);
      plotCanvases.set(key, canvas);
    });
  }

  function activeCurves() {
    return curveOrder.filter((key) => curves[key]);
  }

  function animationLoop() {
    if (latestSnapshot) drawPlots(latestSnapshot);
    requestAnimationFrame(animationLoop);
  }

  function drawPlots(snapshot) {
    const active = activeCurves();
    const data = snapshot.data;
    if (!data || !data.t || data.t.length < 2) return;

    const t = data.t;
    const tMax = t[t.length - 1] || 0;
    const tMin = Math.max(0, tMax - snapshot.sim.displayWindow);
    const markerEvents = (snapshot.events || []).filter((event) => {
      return (event.type === "trigger" || event.type === "cycle") && event.t >= tMin && event.t <= tMax;
    });

    active.forEach((key, index) => {
      const canvas = plotCanvases.get(key);
      if (!canvas) return;
      const y = data[key];
      drawSingleCurve(canvas, key, index === active.length - 1, t, y, tMin, tMax, markerEvents);
    });
  }

  function drawSingleCurve(canvas, key, showXAxis, t, y, tMin, tMax, markerEvents) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const def = curveDefs[key];
    const left = 52;
    const right = 12;
    const top = 20;
    const bottom = showXAxis ? 24 : 10;
    const plotW = Math.max(10, width - left - right);
    const plotH = Math.max(10, height - top - bottom);
    const xSpan = Math.max(0.1, tMax - tMin);
    const range = yRange(key, t, y, tMin);
    const yMin = range[0];
    const yMax = range[1];
    const ySpan = Math.max(0.1, yMax - yMin);

    ctx.fillStyle = "#fbfdff";
    ctx.fillRect(0, 0, width, height);

    drawGrid(ctx, left, top, plotW, plotH, width, height, yMin, yMax, showXAxis);
    drawMarkers(ctx, markerEvents, tMin, xSpan, left, top, plotW, plotH);

    ctx.strokeStyle = def.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    let started = false;
    const stride = Math.max(1, Math.floor(t.length / Math.max(plotW * 1.5, 1)));
    for (let i = 0; i < t.length; i += stride) {
      if (t[i] < tMin) continue;
      const x = left + ((t[i] - tMin) / xSpan) * plotW;
      const yy = top + (1 - ((y[i] - yMin) / ySpan)) * plotH;
      if (!Number.isFinite(x) || !Number.isFinite(yy)) continue;
      if (!started) {
        ctx.moveTo(x, yy);
        started = true;
      } else {
        ctx.lineTo(x, yy);
      }
    }
    ctx.stroke();

    ctx.fillStyle = "#18212c";
    ctx.font = "700 12px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillText(def.title, 8, 14);
    ctx.fillStyle = "#657383";
    ctx.font = "11px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillText(def.unit, 8, 30);
    ctx.textAlign = "right";
    ctx.fillText(formatAxis(yMax), left - 5, top + 4);
    ctx.fillText(formatAxis(yMin), left - 5, top + plotH);
    ctx.textAlign = "left";

    if (showXAxis) {
      ctx.fillStyle = "#657383";
      ctx.font = "11px system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.fillText(formatAxis(tMin) + " s", left, height - 7);
      ctx.textAlign = "right";
      ctx.fillText(formatAxis(tMax) + " s", left + plotW, height - 7);
      ctx.textAlign = "left";
    }

    if (key === "state") {
      drawStateLabels(ctx, left + plotW + 1, top, plotH);
    }
  }

  function drawGrid(ctx, left, top, plotW, plotH, width, height, yMin, yMax, showXAxis) {
    ctx.strokeStyle = "#dce5ec";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i += 1) {
      const x = left + (plotW * i) / 4;
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotH);
    }
    for (let i = 0; i <= 3; i += 1) {
      const y = top + (plotH * i) / 3;
      ctx.moveTo(left, y);
      ctx.lineTo(left + plotW, y);
    }
    ctx.stroke();

    ctx.strokeStyle = "#c7d3dc";
    ctx.strokeRect(left, top, plotW, plotH);
    if (!showXAxis) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, height - 8, width, 8);
    }
  }

  function drawMarkers(ctx, events, tMin, xSpan, left, top, plotW, plotH) {
    events.forEach((event) => {
      const x = left + ((event.t - tMin) / xSpan) * plotW;
      if (x < left || x > left + plotW) return;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = event.type === "trigger" ? "#002677" : "#c9651d";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotH);
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawStateLabels(ctx, x, top, plotH) {
    ctx.fillStyle = "#657383";
    ctx.font = "10px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("OCC", x, top + 6);
    ctx.fillText("INSP", x, top + plotH / 2 + 4);
    ctx.fillText("EXP", x, top + plotH);
    ctx.textAlign = "left";
  }

  function yRange(key, t, y, tMin) {
    const def = curveDefs[key];
    if (key === "state") return def.defaults.slice();
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < y.length; i += 1) {
      if (t[i] < tMin) continue;
      const value = y[i];
      if (!Number.isFinite(value)) continue;
      minVal = Math.min(minVal, value);
      maxVal = Math.max(maxVal, value);
    }
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return def.defaults.slice();
    minVal = Math.min(def.defaults[0], minVal - def.pad);
    maxVal = Math.max(def.defaults[1], maxVal + def.pad);
    if (minVal === maxVal) maxVal = minVal + 1;
    return [minVal, maxVal];
  }

  function updateReadouts(snapshot) {
    const m = snapshot.metrics || {};
    setMetric("vtMl", fmt(m.vtMl, "%.0f mL"));
    setMetric("rrVent", fmt(m.rrVent, "%.1f bpm"));
    setMetric("rrNeural", fmt(m.rrNeural, "%.0f bpm"));
    setMetric("tiVent", fmt(m.tiVent, "%.2f s"));
    setMetric("tiNeural", fmt(m.tiNeural, "%.2f s"));
    setMetric("flowPeak", fmt(m.flowPeak, "%.2f L/s"));
    setMetric("pesSwing", fmt(m.pesSwing, "%.1f cmH2O"));
    setMetric("p01", fmt(m.p01, "%.1f cmH2O"));
    setMetric("dpocc", fmt(m.dpocc, "%.1f cmH2O"));
    setMetric("mif", fmt(m.mif, "%.1f cmH2O"));
    setMetric("pmi", fmt(m.pmi, "%.1f cmH2O"));
    setMetric("effortProxy", fmt(m.effortProxy, "%.1f cmH2O*s"));
    setMetric("stateText", snapshot.stateText || "--");

    el.runStatus.textContent = (snapshot.running ? "Running" : "Paused") +
      "  t = " + fmt(snapshot.t, "%.1f s") +
      "  ratio " + fmt(snapshot.sim.timeRatio, "%.1f x");

    el.maneuverStatus.textContent = "Pending: " + (snapshot.pendingManeuver || "none");

    const events = (snapshot.events || []).slice(-12).reverse();
    el.eventLog.textContent = events.length
      ? events.map((event) => pad(event.t.toFixed(2), 7) + " s  " + event.label).join("\n")
      : "Ready";
  }

  function setMetric(key, value) {
    const target = document.querySelector('[data-metric="' + key + '"]');
    if (target) target.textContent = value;
  }

  function exportCsv() {
    if (!latestSnapshot || !latestSnapshot.data || !latestSnapshot.data.t.length) return;
    const d = latestSnapshot.data;
    const rows = [
      "time_s,Paw_cmH2O,Flow_Lps,VolumeRelFRC_L,VolumeAbsApprox_L,Pes_cmH2O,PmusEquivalent_cmH2O,StateCode"
    ];
    for (let i = 0; i < d.t.length; i += 1) {
      const absVolume = params.patient.frc + d.volume[i];
      rows.push([
        d.t[i], d.paw[i], d.flow[i], d.volume[i], absVolume, d.pes[i], d.pmus[i], d.state[i]
      ].map((value) => Number(value).toFixed(5)).join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "PSV_waveform_" + new Date().toISOString().replace(/[:.]/g, "-") + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function defaultParams() {
    return {
      vent: {
        peep: 5,
        ps: 10,
        triggerFlowLmin: 2,
        ets: 25,
        riseMs: 120,
        backupOn: false,
        backupRate: 12,
        leakLmin: 0
      },
      patient: {
        crs: 50,
        rrs: 8,
        frc: 2.5,
        autoPeep: 0,
        leakLmin: 0
      },
      effort: {
        rr: 16,
        deltaPes: 8,
        ti: 0.9,
        shape: "Smooth ramp",
        strength: "Normal"
      }
    };
  }

  function defaultSim() {
    return {
      dt: 0.01,
      timerPeriod: 0.03,
      timeRatio: 3.4,
      displayWindow: 25,
      maxVolume: 4.5,
      minExpTime: 0.25,
      minInspTime: 0.25,
      maxInspTime: 2.5,
      refractoryTime: 0.3
    };
  }

  function presetParams(name) {
    const p = defaultParams();
    if (name === "Overassistance") {
      p.vent.ps = 22;
      p.vent.ets = 10;
      p.vent.riseMs = 80;
      p.patient.crs = 65;
      p.patient.rrs = 6;
      p.effort.rr = 10;
      p.effort.deltaPes = 3.5;
      p.effort.ti = 0.55;
      p.effort.strength = "Weak";
    } else if (name === "Underassistance") {
      p.vent.ps = 4;
      p.vent.triggerFlowLmin = 4;
      p.vent.ets = 35;
      p.patient.crs = 35;
      p.patient.rrs = 14;
      p.patient.autoPeep = 2;
      p.effort.rr = 28;
      p.effort.deltaPes = 20;
      p.effort.ti = 0.95;
      p.effort.strength = "Strong";
    } else if (name === "Ineffective effort") {
      p.vent.ps = 14;
      p.vent.triggerFlowLmin = 8;
      p.vent.ets = 25;
      p.patient.autoPeep = 7;
      p.patient.rrs = 16;
      p.effort.rr = 24;
      p.effort.deltaPes = 5;
      p.effort.ti = 0.7;
      p.effort.strength = "Weak";
    } else if (name === "Premature cycling") {
      p.vent.ps = 9;
      p.vent.ets = 70;
      p.vent.riseMs = 70;
      p.patient.rrs = 10;
      p.effort.rr = 18;
      p.effort.deltaPes = 13;
      p.effort.ti = 1.3;
    } else if (name === "Delayed cycling") {
      p.vent.ps = 17;
      p.vent.ets = 5;
      p.vent.riseMs = 80;
      p.vent.leakLmin = 8;
      p.patient.rrs = 7;
      p.effort.rr = 14;
      p.effort.deltaPes = 7;
      p.effort.ti = 0.55;
      p.effort.strength = "Weak";
    } else if (name === "Auto-trigger / leak") {
      p.vent.ps = 10;
      p.vent.triggerFlowLmin = 0.8;
      p.vent.ets = 25;
      p.vent.leakLmin = 28;
      p.patient.leakLmin = 12;
      p.effort.rr = 8;
      p.effort.deltaPes = 2;
      p.effort.ti = 0.55;
      p.effort.strength = "Weak";
    }
    return p;
  }

  function getPath(object, path) {
    return path.split(".").reduce((value, key) => value[key], object);
  }

  function setPath(object, path, value) {
    const parts = path.split(".");
    let target = object;
    for (let i = 0; i < parts.length - 1; i += 1) target = target[parts[i]];
    target[parts[parts.length - 1]] = value;
  }

  function formatValue(value, pattern) {
    return fmt(value, pattern);
  }

  function fmt(value, pattern) {
    if (!Number.isFinite(value)) return "--";
    const match = pattern.match(/%\.(\d)f/);
    const digits = match ? Number(match[1]) : 1;
    return pattern.replace(/%\.\df/, value.toFixed(digits));
  }

  function formatAxis(value) {
    if (Math.abs(value) >= 100) return value.toFixed(0);
    if (Math.abs(value) >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  function pad(text, length) {
    return text.length >= length ? text : " ".repeat(length - text.length) + text;
  }

  function workerSource() {
    return `
      "use strict";

      let params = defaultParams();
      let sim = defaultSim();
      let running = false;
      let pendingManeuver = "none";
      let s;
      let buf;
      let events;
      let metrics;
      let lastPost = 0;

      resetState(false);

      self.onmessage = function (event) {
        const msg = event.data;
        if (msg.type === "init") {
          params = clone(msg.params || defaultParams());
          sim = Object.assign(defaultSim(), msg.sim || {});
          resetState(false);
          postSnapshot();
        } else if (msg.type === "start") {
          running = true;
          postSnapshot();
        } else if (msg.type === "pause") {
          running = false;
          postSnapshot();
        } else if (msg.type === "reset") {
          params = clone(msg.params || params);
          sim = Object.assign(sim, msg.sim || {});
          resetState(false);
          postSnapshot();
        } else if (msg.type === "setParam") {
          setPath(params, msg.path, msg.value);
          postSnapshot();
        } else if (msg.type === "setParams") {
          params = clone(msg.params || params);
          postSnapshot();
        } else if (msg.type === "setSim") {
          sim = Object.assign(sim, msg.sim || {});
          trimBuffer();
          postSnapshot();
        } else if (msg.type === "maneuver") {
          pendingManeuver = msg.maneuver || "none";
          addEvent(s.t, occLabel(pendingManeuver) + " pending", "info");
          postSnapshot();
        } else if (msg.type === "preset") {
          const keepRunning = running;
          params = clone(msg.params || defaultParams());
          sim = Object.assign(sim, msg.sim || {});
          resetState(keepRunning);
          addEvent(s.t, "preset: " + msg.name, "info");
          postSnapshot();
        }
      };

      setInterval(function () {
        if (!running) return;
        const baseSteps = sim.timerPeriod / sim.dt;
        const steps = Math.max(1, Math.round(baseSteps * Math.max(0.1, sim.timeRatio)));
        for (let i = 0; i < steps; i += 1) step();
        const now = Date.now();
        if (now - lastPost >= 45) postSnapshot();
      }, 30);

      function resetState(keepRunning) {
        const c = Math.max(params.patient.crs / 1000, 0.005);
        const v0 = Math.max(0, c * (params.vent.peep - params.patient.autoPeep));
        s = {
          t: 0,
          V: v0,
          Paw: params.vent.peep,
          flowPatient: 0,
          flowMeasured: 0,
          PmusDrive: 0,
          PesBaseline: -5,
          Pes: -5,
          ventState: "EXP",
          inspStart: NaN,
          inspPeakFlow: NaN,
          inspVmin: v0,
          inspVmax: v0,
          lastVentTriggerTime: 0,
          lastCycleTime: -Infinity,
          ventTriggerTimes: [],
          nextNeuralOnset: 0.5,
          neuralActive: false,
          neuralStart: NaN,
          neuralEnd: NaN,
          effortId: 0,
          currentEffortArea: 0,
          currentPesMin: -5,
          currentPesMax: -5,
          occType: "none",
          occStart: NaN,
          occEnd: NaN,
          occPawStart: NaN,
          occPawMin: NaN,
          occPawMax: NaN,
          occPawAssistEnd: NaN
        };
        buf = { t: [], paw: [], flow: [], volume: [], pes: [], pmus: [], state: [] };
        events = [];
        metrics = emptyMetrics();
        metrics.rrNeural = params.effort.rr;
        metrics.tiNeural = params.effort.ti;
        pendingManeuver = "none";
        running = Boolean(keepRunning);
        pushSample();
      }

      function step() {
        const dt = sim.dt;
        s.t += dt;
        const t = s.t;

        const neuralPeriod = Math.max(60 / Math.max(params.effort.rr, 1), params.effort.ti + 0.2);
        if (t >= s.nextNeuralOnset - 0.5 * dt) {
          s.neuralActive = true;
          s.neuralStart = s.nextNeuralOnset;
          s.neuralEnd = s.neuralStart + params.effort.ti;
          s.nextNeuralOnset = s.neuralStart + neuralPeriod;
          s.effortId += 1;
          s.currentEffortArea = 0;
          s.currentPesMin = s.PesBaseline;
          s.currentPesMax = s.PesBaseline;

          if (pendingManeuver === "DPOCC" && s.ventState === "EXP") {
            startOcclusion("DPOCC", Math.max(0.8, Math.min(1.4, params.effort.ti + 0.25)));
          }
        }

        if (s.neuralActive && t <= s.neuralEnd) {
          s.PmusDrive = neuralEffort(t, s.neuralStart, params.effort.ti, params.effort.deltaPes, params.effort.shape);
        } else {
          s.PmusDrive = 0;
        }

        s.Pes = s.PesBaseline - s.PmusDrive;
        if (s.neuralActive) {
          s.currentEffortArea += s.PmusDrive * dt;
          s.currentPesMin = Math.min(s.currentPesMin, s.Pes);
          s.currentPesMax = Math.max(s.currentPesMax, s.Pes);
        }
        if (s.neuralActive && t >= s.neuralEnd) {
          s.neuralActive = false;
          metrics.effortProxy = s.currentEffortArea;
          metrics.pesSwing = Math.max(0, s.currentPesMax - s.currentPesMin);
        }

        const c = Math.max(params.patient.crs / 1000, 0.005);
        const r = Math.max(params.patient.rrs, 0.1);
        const totalLeak = Math.max(0, params.vent.leakLmin + params.patient.leakLmin) / 60;

        if (s.ventState === "OCC") {
          s.Paw = s.V / c + params.patient.autoPeep - s.PmusDrive;
          s.flowPatient = 0;
          s.flowMeasured = 0;
          s.occPawMin = Math.min(s.occPawMin, s.Paw);
          s.occPawMax = Math.max(s.occPawMax, s.Paw);
          if (t >= s.occEnd) finishOcclusion();
        } else {
          if (s.ventState === "INSP") {
            const rise = Math.max(params.vent.riseMs / 1000, dt);
            const x = Math.min(1, Math.max(0, (t - s.inspStart) / rise));
            const smoothRise = x * x * (3 - 2 * x);
            s.Paw = params.vent.peep + params.vent.ps * smoothRise;
          } else {
            s.Paw = params.vent.peep;
          }

          s.flowPatient = (s.Paw + s.PmusDrive - params.patient.autoPeep - s.V / c) / r;
          let newV = s.V + s.flowPatient * dt;
          if (newV < 0) {
            s.flowPatient = -s.V / dt;
            newV = 0;
          } else if (newV > sim.maxVolume) {
            s.flowPatient = (sim.maxVolume - s.V) / dt;
            newV = sim.maxVolume;
          }
          s.V = newV;
          s.flowMeasured = s.flowPatient + totalLeak;

          if (s.ventState === "EXP") {
            evaluateTrigger();
          } else if (s.ventState === "INSP") {
            s.inspPeakFlow = Math.max(s.inspPeakFlow, s.flowMeasured);
            s.inspVmin = Math.min(s.inspVmin, s.V);
            s.inspVmax = Math.max(s.inspVmax, s.V);
            metrics.vtMl = Math.max(0, s.inspVmax - s.inspVmin) * 1000;
            metrics.tiVent = Math.max(0, t - s.inspStart);
            metrics.flowPeak = s.inspPeakFlow;
            evaluateCycling();
          }
        }

        pushSample();
      }

      function neuralEffort(t, t0, ti, amp, shapeName) {
        if (ti <= 0) return 0;
        const x = (t - t0) / ti;
        if (x < 0 || x > 1) return 0;
        let y;
        if (shapeName === "Sinusoidal") {
          y = amp * Math.sin(Math.PI * x);
        } else if (shapeName === "Trapezoidal") {
          const ramp = 0.22;
          if (x < ramp) y = amp * (x / ramp);
          else if (x > 1 - ramp) y = amp * ((1 - x) / ramp);
          else y = amp;
        } else {
          const rise = 0.35;
          if (x < rise) {
            const z = x / rise;
            y = amp * (z * z * (3 - 2 * z));
          } else {
            const z = (x - rise) / (1 - rise);
            y = amp * 0.5 * (1 + Math.cos(Math.PI * z));
          }
        }
        return Math.max(0, y);
      }

      function evaluateTrigger() {
        const t = s.t;
        const threshold = Math.max(0.01, params.vent.triggerFlowLmin / 60);
        const canTrigger = s.ventState === "EXP" &&
          (t - s.lastCycleTime >= sim.minExpTime) &&
          (t - s.lastVentTriggerTime >= sim.refractoryTime);

        if (canTrigger && s.flowMeasured >= threshold) {
          if (pendingManeuver === "P01") {
            registerVentTrigger();
            startOcclusion("P01", 0.1);
          } else if (pendingManeuver === "MIF") {
            registerVentTrigger();
            startOcclusion("MIF", 1.5);
          } else {
            beginInspiration(true);
          }
          return;
        }

        const backupInterval = 60 / Math.max(params.vent.backupRate, 1);
        const backupDue = params.vent.backupOn && t > 1 && (t - s.lastVentTriggerTime >= backupInterval);
        if (canTrigger && backupDue) beginInspiration(true);
      }

      function evaluateCycling() {
        const inspTime = s.t - s.inspStart;
        const peak = Math.max(s.inspPeakFlow, 0.001);
        const cycleFlow = peak * params.vent.ets / 100;
        const flowCycle = inspTime >= sim.minInspTime && s.flowMeasured <= cycleFlow && peak > 0.05;
        const forcedCycle = inspTime >= sim.maxInspTime;
        if (flowCycle || forcedCycle) {
          registerCycle();
          if (pendingManeuver === "PMI") startOcclusion("PMI", 0.45);
          else enterExpiration();
        }
      }

      function registerVentTrigger() {
        const t = s.t;
        s.lastVentTriggerTime = t;
        s.ventTriggerTimes.push(t);
        s.ventTriggerTimes = s.ventTriggerTimes.filter((value) => value >= t - 60);
        if (s.ventTriggerTimes.length >= 2) {
          const recent = s.ventTriggerTimes.slice(-6);
          let sum = 0;
          for (let i = 1; i < recent.length; i += 1) sum += recent[i] - recent[i - 1];
          metrics.rrVent = 60 / (sum / (recent.length - 1));
        }
        addEvent(t, "ventilator trigger", "trigger");
      }

      function beginInspiration(countAsTrigger) {
        if (countAsTrigger) registerVentTrigger();
        s.ventState = "INSP";
        s.inspStart = s.t;
        s.inspPeakFlow = Math.max(0, s.flowMeasured);
        s.inspVmin = s.V;
        s.inspVmax = s.V;
      }

      function registerCycle() {
        const t = s.t;
        const ti = Math.max(0, t - s.inspStart);
        const vt = Math.max(0, s.inspVmax - s.inspVmin);
        metrics.vtMl = vt * 1000;
        metrics.tiVent = ti;
        metrics.flowPeak = s.inspPeakFlow;
        s.lastCycleTime = t;
        addEvent(t, "cycling-off", "cycle");
      }

      function enterExpiration() {
        s.ventState = "EXP";
        s.inspStart = NaN;
        s.inspPeakFlow = NaN;
        s.lastCycleTime = s.t;
      }

      function startOcclusion(type, duration) {
        s.ventState = "OCC";
        s.occType = type;
        s.occStart = s.t;
        s.occEnd = s.t + duration;
        s.occPawStart = s.Paw;
        s.occPawMin = s.Paw;
        s.occPawMax = s.Paw;
        s.occPawAssistEnd = type === "PMI" ? s.Paw : NaN;
        s.flowPatient = 0;
        s.flowMeasured = 0;
        pendingManeuver = "none";
        addEvent(s.t, occLabel(type) + " start", "info");
      }

      function finishOcclusion() {
        const type = s.occType;
        if (type === "P01") {
          metrics.p01 = Math.max(0, s.occPawStart - s.Paw);
          addEvent(s.t, "P0.1 " + metrics.p01.toFixed(1) + " cmH2O", "info");
          s.ventState = "EXP";
          s.occType = "none";
          beginInspiration(false);
        } else if (type === "MIF") {
          metrics.mif = s.occPawMin - s.occPawStart;
          addEvent(s.t, "MIF/NIF " + metrics.mif.toFixed(1) + " cmH2O", "info");
          s.ventState = "EXP";
          s.occType = "none";
          beginInspiration(false);
        } else if (type === "DPOCC") {
          metrics.dpocc = s.occPawMin - s.occPawStart;
          addEvent(s.t, "DeltaPocc " + metrics.dpocc.toFixed(1) + " cmH2O", "info");
          s.ventState = "EXP";
          s.occType = "none";
          s.lastCycleTime = s.t;
        } else if (type === "PMI") {
          metrics.pmi = Math.max(0, s.occPawMax - s.occPawAssistEnd);
          addEvent(s.t, "PMI proxy " + metrics.pmi.toFixed(1) + " cmH2O", "info");
          s.ventState = "EXP";
          s.occType = "none";
          s.lastCycleTime = s.t;
        } else {
          s.ventState = "EXP";
          s.occType = "none";
          s.lastCycleTime = s.t;
        }
      }

      function pushSample() {
        buf.t.push(s.t);
        buf.paw.push(s.Paw);
        buf.flow.push(s.flowMeasured);
        buf.volume.push(s.V);
        buf.pes.push(s.Pes);
        buf.pmus.push(-s.PmusDrive);
        buf.state.push(stateCode(s.ventState));
      }

      function trimBuffer() {
        const keepAfter = Math.max(0, s.t - sim.displayWindow - 2);
        let first = 0;
        while (first < buf.t.length && buf.t[first] < keepAfter) first += 1;
        if (first > 0) {
          Object.keys(buf).forEach((key) => {
            buf[key] = buf[key].slice(first);
          });
        }
        events = events.filter((event) => event.t >= Math.max(0, s.t - sim.displayWindow - 5));
      }

      function postSnapshot() {
        trimBuffer();
        lastPost = Date.now();
        metrics.rrNeural = params.effort.rr;
        metrics.tiNeural = params.effort.ti;
        self.postMessage({
          type: "snapshot",
          snapshot: {
            t: s.t,
            running,
            pendingManeuver,
            sim: clone(sim),
            metrics: clone(metrics),
            events: clone(events),
            stateText: stateText(),
            data: clone(buf)
          }
        });
      }

      function stateText() {
        if (!running) return "Paused / " + s.ventState;
        if (s.ventState === "OCC") return "Occlusion: " + s.occType;
        return s.ventState;
      }

      function stateCode(name) {
        if (name === "INSP") return 1;
        if (name === "OCC") return 2;
        return 0;
      }

      function addEvent(t, label, type) {
        events.push({ t, label, type });
        if (events.length > 250) events = events.slice(-250);
      }

      function occLabel(type) {
        if (type === "P01") return "P0.1 occlusion";
        if (type === "MIF") return "MIF occlusion";
        if (type === "DPOCC") return "DeltaPocc occlusion";
        if (type === "PMI") return "PMI occlusion";
        return "occlusion";
      }

      function emptyMetrics() {
        return {
          vtMl: NaN,
          rrVent: NaN,
          rrNeural: NaN,
          tiVent: NaN,
          tiNeural: NaN,
          flowPeak: NaN,
          pesSwing: NaN,
          p01: NaN,
          dpocc: NaN,
          mif: NaN,
          pmi: NaN,
          effortProxy: NaN
        };
      }

      function defaultParams() {
        return {
          vent: {
            peep: 5,
            ps: 10,
            triggerFlowLmin: 2,
            ets: 25,
            riseMs: 120,
            backupOn: false,
            backupRate: 12,
            leakLmin: 0
          },
          patient: {
            crs: 50,
            rrs: 8,
            frc: 2.5,
            autoPeep: 0,
            leakLmin: 0
          },
          effort: {
            rr: 16,
            deltaPes: 8,
            ti: 0.9,
            shape: "Smooth ramp",
            strength: "Normal"
          }
        };
      }

      function defaultSim() {
        return {
          dt: 0.01,
          timerPeriod: 0.03,
          timeRatio: 3.4,
          displayWindow: 25,
          maxVolume: 4.5,
          minExpTime: 0.25,
          minInspTime: 0.25,
          maxInspTime: 2.5,
          refractoryTime: 0.3
        };
      }

      function setPath(object, path, value) {
        const parts = path.split(".");
        let target = object;
        for (let i = 0; i < parts.length - 1; i += 1) target = target[parts[i]];
        target[parts[parts.length - 1]] = value;
      }

      function clone(value) {
        return JSON.parse(JSON.stringify(value));
      }
    `;
  }
})();
