const svg = document.querySelector("[data-gm-svg]");
const stage = document.querySelector("[data-gm-stage]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const n = (value) => Math.round(value).toLocaleString("en-US");
const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pick = (value, gpu) => (value && typeof value === "object" && !Array.isArray(value) ? value[gpu] : value);
const pillLayer = svg.querySelector("[data-pills]");

function visualLen(str) {
  let len = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xff00 && code <= 0xffef)) {
      len += 1.85;
    } else {
      len += 1;
    }
  }
  return len;
}
Ink.pillSvg = function ([ax, ay], dx, dy, text, on, size = 10.5) {
  const w = visualLen(text) * size * 0.62 + size * 1.6;
  const h = size * 1.85;
  const cx = ax + dx;
  const cy = ay + dy;
  const r = (v) => v.toFixed(1);
  return `<g class="pill${on ? " on" : ""}"><path class="lead" d="M${r(ax)} ${r(ay)}L${r(cx)} ${r(cy + h / 2)}"/><circle class="lead-dot" cx="${r(ax)}" cy="${r(ay)}" r="1.6"/><rect x="${r(cx - w / 2)}" y="${r(cy - h / 2)}" width="${r(w)}" height="${r(h)}" rx="${r(h / 2)}"/><text x="${r(cx)}" y="${r(cy + size * 0.36)}" font-size="${size}" text-anchor="middle">${text}</text></g>`;
};

let currentLang = "en";
function getInitialLang() {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q && q.toLowerCase().startsWith("zh")) return "zh";
    const saved = localStorage.getItem("lang");
    if (saved && saved.toLowerCase().startsWith("zh")) return "zh";
    if (!saved && navigator.language && navigator.language.toLowerCase().startsWith("zh")) return "zh";
  } catch (_) {}
  return "en";
}
currentLang = getInitialLang();

const RIGS = {};
for (const [name, rig] of Object.entries(D.rigs)) {
  const layer = svg.querySelector(`[data-rig="${name}"]`);
  const sorted = layer.querySelector("[data-layer]");
  const nodes = {};
  rig.items.forEach((item) => (nodes[item.id] = sorted.querySelector(`:scope > g[data-i="${item.id}"]`)));
  const cells = [];
  const total = rig.CHIPS * 48;
  for (let g = 0; g < total; g++) cells.push(layer.querySelector(`[data-cell="${g % rig.CHIPS}:${Math.floor(g / rig.CHIPS)}"]`));
  RIGS[name] = { ...rig, layer, sorted, nodes, cells, live: (id) => layer.querySelector(`[data-live="${id}"]`), sms: Array.from(layer.querySelectorAll(".sm[data-sm]")), cores: Array.from(layer.querySelectorAll(".core")), l2: Array.from(layer.querySelectorAll(".l2")), mcs: Array.from(layer.querySelectorAll(".mc, .io")), packets: Array.from(layer.querySelectorAll("[data-pk]")), pulses: Array.from(layer.querySelectorAll("[data-lp]")), queue: Array.from(layer.querySelectorAll("[data-q]")) };
}

function along(points, t) {
  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    lengths.push(l);
    total += l;
  }
  let at = clamp(t, 0, 1) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (at <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] ? Math.min(1, at / lengths[i]) : 0;
      const a = points[i];
      const b = points[i + 1];
      return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
    }
    at -= lengths[i];
  }
  return points[points.length - 1].slice();
}
const lengthOf = (points) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1], p[2] - points[i][2]), 0);

function freshPose(rig) {
  return { req: rig.WAYPOINTS.port.slice(), reqOn: 0, queue: 0, poolUsed: 0, mine: 0, fill: 0, pre: 0, read: 0, sm: 0, l2: 0, mc: 0, core: "", flowOn: 0, flowDir: 1, flow: 0, launchOn: 0, lphase: 0, gbs: 0, stepT: -1, lamps: {}, hot: [] };
}

function beatsFor(sim) {
  const rig = RIGS[sim.config.gpu];
  const W = rig.WAYPOINTS;
  const beats = [];
  const b = (d, to = {}, extra = {}) => beats.push({ d, to, ...extra });
  const go = (points, hot) => beats.push({ d: "path", to: {}, path: points, hot });
  const dec = sim.decode;
  const share = dec.share === null ? 0.62 : dec.share;
  const readDur = clamp(1.25 * share, 0.35, 1.2);
  const compDur = clamp(1.25 * (1 - share), 0.12, 0.7);
  const send = rig.LAUNCH.slice(1);
  const back = send.slice().reverse().concat([W.detok]);
  const gbs = dec.effectiveGBs || 0;
  const decodeCycle = (read, comp, lampOf) => {
    b(read, { read: 1, gbs, stepT: share }, { hot: ["weights"], start: (p) => Object.assign(p, { read: 0, stepT: 0, flowOn: 1, flowDir: 1, l2: 1, mc: 1, launchOn: sim.config.graphs ? 0 : 1 }, lampOf(p)) });
    b(comp, { gbs: 0, stepT: 1 }, { hot: ["sms"], start: (p) => Object.assign(p, { flowOn: 0, l2: 0, mc: 0, sm: 1 }), end: (p) => Object.assign(p, { sm: 0, read: 0, launchOn: 0, stepT: -1 }) });
  };
  sim.events.forEach((ev, index) => {
    const mark = beats.length;
    const lamp = (p) => ((p.lamps[ev.station] = ev.lamp), {});
    switch (ev.type) {
      case "arrive":
        b(0.5, {}, { hot: ["ingress"], start: (p) => Object.assign(p, { reqOn: 1, req: W.port.slice() }, lamp(p)) });
        break;
      case "tokenize":
        go([W.tokenizer], ["tokenizer"]);
        b(0.6, {}, { hot: ["tokenizer"], start: (p) => Object.assign(p, { core: "tok" }, lamp(p)), end: (p) => (p.core = "") });
        break;
      case "match":
        go([W.scheduler], ["scheduler"]);
        b(0.8, {}, { hot: ["scheduler", "pool"], start: (p) => Object.assign(p, { core: "sched", poolUsed: ev.poolUsed, pre: ev.matched > 0 ? 1 : 0 }, lamp(p)), end: (p) => (p.core = "") });
        break;
      case "queue":
        go([W.queue], ["scheduler"]);
        b(1.0, {}, { hot: ["scheduler", "pool"], start: (p) => Object.assign(p, { queue: Math.min(8, ev.waiting), poolUsed: ev.poolUsed }, lamp(p)) });
        break;
      case "admit":
        go([W.scheduler], ["scheduler"]);
        b(0.7, {}, { hot: ["scheduler", "pool"], start: (p) => Object.assign(p, { queue: 0, core: "sched", poolUsed: ev.poolUsed, mine: ev.mine, fill: 0 }, lamp(p)), end: (p) => (p.core = "") });
        break;
      case "send":
        go(send, ["link"]);
        b(0.3, {}, { hot: ["link"], start: lamp });
        break;
      case "reuse":
        b(0.9, {}, { hot: ["pool"], start: (p) => Object.assign(p, { pre: 1 }, lamp(p)) });
        break;
      case "prefill":
        if (ev.chunk === 1) go([W.die], ["sms"]);
        b(1.0, { fill: ev.chunk / ev.chunks }, { hot: ["sms"], start: (p) => Object.assign(p, { sm: 1, flowOn: 1, flowDir: -1, mc: 1 }, lamp(p)), end: (p) => Object.assign(p, { sm: 0, flowOn: 0, mc: 0 }) });
        break;
      case "first":
        b(0.5, {}, { hot: ["sms"], start: (p) => Object.assign(p, { pre: 0, fill: 1 }, lamp(p)) });
        break;
      case "decode":
        decodeCycle(readDur, compDur, lamp);
        break;
      case "decode-rest":
        for (let i = 0; i < 3; i++) decodeCycle(clamp(readDur * 0.4, 0.14, 0.5), clamp(compDur * 0.5, 0.1, 0.3), lamp);
        break;
      case "detok":
        go(back, ["link"]);
        b(0.6, {}, { hot: ["detok"], start: (p) => Object.assign(p, { core: "detok" }, lamp(p)), end: (p) => (p.core = "") });
        break;
      case "exit":
        go([W.port], ["ingress"]);
        b(0.6, {}, { hot: ["ingress"], start: (p) => Object.assign(p, { mine: 0, fill: 0, poolUsed: ev.poolUsed }, lamp(p)), end: (p) => (p.reqOn = 0) });
        break;
    }
    beats[mark].event = index;
  });
  let pos = W.port.slice();
  for (const beat of beats) {
    if (beat.d === "path") {
      beat._points = [pos, ...beat.path];
      beat._dur = Math.min(1.3, 0.3 + lengthOf(beat._points) / 170);
      pos = beat.path[beat.path.length - 1].slice();
    } else beat._dur = beat.d;
  }
  return beats;
}

function timingOf(sim, beats) {
  const per = sim.events.map(() => 0);
  let current = -1;
  for (const beat of beats) {
    if (beat.event !== undefined) current = beat.event;
    per[current] += beat._dur;
  }
  const p = sim.point;
  const first = sim.events.findIndex((ev) => ev.type === "first");
  const preAnim = per.slice(0, first + 1).reduce((a, b) => a + b, 0);
  return sim.events.map((ev, i) => {
    if (!p) return null;
    if (i <= first) return { real: p.ttft, anim: preAnim };
    if (ev.type === "decode") return { real: p.tpot, anim: per[i] };
    if (ev.type === "decode-rest") return { real: p.tpot * (sim.admission.output - 1 - M.SHOWN_STEPS), anim: per[i] };
    return null;
  });
}
function badgeOf(timing) {
  if (!timing) return "not timed";
  const ratio = (timing.anim * 1000) / timing.real;
  return ratio >= 1 ? `x1/${Math.round(ratio).toLocaleString("en-US")}` : `x${Math.round(1 / ratio).toLocaleString("en-US")}`;
}

const state = { config: M.decode(location.search), sim: null, beats: [], bi: 0, bt: 0, pose: null, playing: false, stopAt: -1, shown: -1, done: false, speed: 1, selected: null, rigName: "", explode: { target: 0, shares: {} } };

function rig() {
  return RIGS[state.config.gpu];
}

function load(config, { autoplay = false } = {}) {
  state.config = M.configOf(config);
  state.sim = M.simulate(state.config);
  if (state.rigName !== state.config.gpu) {
    state.rigName = state.config.gpu;
    for (const [name, r] of Object.entries(RIGS)) r.layer.style.display = name === state.rigName ? "" : "none";
    state.explode.shares = {};
    rig().ASSEMBLIES.forEach((asm) => (state.explode.shares[asm] = { x: state.explode.target, v: 0, goal: state.explode.target }));
    lastOrder = "";
    lastPills = "";
  }
  state.beats = beatsFor(state.sim);
  state.timing = timingOf(state.sim, state.beats);
  let currentEvent = 0;
  state.beatStep = state.beats.map((beat) => (beat.event !== undefined && (currentEvent = beat.event), M.stepOf(state.sim.events[currentEvent].type)));
  Object.assign(state, { pose: freshPose(rig()), bi: 0, bt: 0, shown: -1, done: false, stopAt: -1, time: 0 });
  lastCells = "";
  syncControls();
  writeUrl();
  render(-1);
  draw();
  autoplay ? play() : pause();
}

function begin(beat) {
  if (beat.event !== undefined) onEvent(beat.event);
  if (beat.start) beat.start(state.pose);
  beat._from = {};
  for (const key of Object.keys(beat.to)) beat._from[key] = state.pose[key];
  state.pose.hot = beat.hot || [];
}
function apply(beat, t) {
  for (const [key, target] of Object.entries(beat.to)) state.pose[key] = lerp(beat._from[key], target, ease(t));
  if (beat._points) state.pose.req = along(beat._points, ease(t));
}

function advance(dt) {
  let left = dt;
  while (left > 0 && state.bi < state.beats.length) {
    const beat = state.beats[state.bi];
    if (state.bt === 0) {
      if (state.stopAt >= 0 && beat.event !== undefined && beat.event > state.stopAt) {
        state.playing = false;
        state.stopAt = -1;
        syncButtons();
        return;
      }
      begin(beat);
    }
    const remaining = beat._dur - state.bt;
    if (left >= remaining) {
      apply(beat, 1);
      if (beat.end) beat.end(state.pose);
      left -= remaining;
      state.time += remaining;
      state.bi += 1;
      state.bt = 0;
    } else {
      state.bt += left;
      state.time += left;
      apply(beat, state.bt / beat._dur);
      left = 0;
    }
  }
  if (state.bi >= state.beats.length && !state.done) {
    state.done = true;
    state.playing = false;
    state.pose.hot = [];
    render(state.sim.events.length - 1);
    const o = state.sim.outcome;
    $("[data-gm-live]").textContent = `Run finished: ${o.status}. ${o.text}`;
    syncButtons();
    if (mode === "auto" && !renderMode) setTimeout(() => mode === "auto" && state.done && play(), 1600);
  }
}

function onEvent(index) {
  state.shown = index;
  render(index);
}

let lastOrder = "";
let lastPills = "";
const narrow = matchMedia("(max-width: 640px)");
const FULL_BOX = svg.getAttribute("viewBox");
const PHONE_BOX = "150 -96 700 764";
const PHONE_PILL = 17;
const offsetOf = (r, asm) => mul(r.EXPLODE[asm] || [0, 0, 0], state.explode.shares[asm] ? state.explode.shares[asm].x : 0);
const explodedAt = (r, label) => K.iso(add(label.at, offsetOf(r, label.asm)), r.P);
function phoneLayout(r) {
  if (r._phone && r._phoneLang === currentLang) return r._phone;
  const width = (text) => visualLen(text) * PHONE_PILL * 0.62 + PHONE_PILL * 1.6;
  const entries = r.LABELS.map((label) => {
    const text = (currentLang === "zh" && I18n.ZH_LABELS[r.name]?.[label.id]) || label.text;
    return { label: { ...label, text }, a: K.iso(label.at, r.P), w: width(text) };
  });
  const ys = entries.map((e) => e.a[1]);
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const out = [];
  for (const [list, rows] of [[entries.filter((e) => e.a[1] < mid), [-72, -36]], [entries.filter((e) => e.a[1] >= mid), [466, 502]]]) {
    list.sort((p, q) => p.a[0] - q.a[0]);
    const half = Math.ceil(list.length / 2);
    [list.slice(0, half), list.slice(half)].forEach((row, ri) => {
      const total = row.reduce((sum, e) => sum + e.w + 8, -8);
      let x = 500 - total / 2;
      row.forEach((e) => {
        const cx = x + e.w / 2;
        x += e.w + 8;
        out.push({ ...e.label, dx: Math.round(cx - e.a[0]), dy: Math.round(rows[ri] - e.a[1]) });
      });
    });
  }
  r._phoneLang = currentLang;
  return (r._phone = out);
}
narrow.addEventListener("change", () => ((lastPills = ""), draw()));
let lastCells = "";
const hash = (g) => ((g * 2654435761) >>> 0) % 1000 / 1000;

function cellKey(pose) {
  return [pose.poolUsed, pose.mine, Math.round(pose.fill * 40), pose.pre, Math.round(pose.read * 24), state.sim.config.dtype, state.sim.pool].join("|");
}

function paintCells(r, pose) {
  const sim = state.sim;
  const mem = sim.memory;
  const adm = sim.admission;
  const chips = r.CHIPS;
  const K = mem.kvCells;
  const tpc = sim.pool / K;
  const sharedFits = adm.prefixFits === true;
  const prefixCells = sharedFits ? Math.min(K, Math.ceil(adm.prefix / tpc)) : 0;
  const myPrefix = sharedFits ? Math.min(prefixCells, Math.ceil(sim.config.shared / tpc)) : 0;
  const mineTokens = pose.mine ? pose.mine * pose.fill : 0;
  const mineCells = pose.mine && pose.fill > 0 ? Math.max(1, Math.round(mineTokens / tpc)) : 0;
  const othersTokens = Math.max(0, pose.poolUsed - (pose.mine || 0) - (sharedFits ? adm.prefix : 0));
  const otherCells = Math.round(othersTokens / tpc);
  const moe = !D.dense[sim.config.gpu];
  const readFrac = moe ? (sim.decode.readGB !== null ? sim.decode.readGB / sim.decode.weightsGB : 0.5) : 1;
  const perChip = mem.weightCells / chips;
  state.mix = { K, prefixCells, myPrefix: pose.pre ? myPrefix : 0, otherCells, mineCells };
  r.cells.forEach((cell, g) => {
    let c = "";
    let read = false;
    if (g < mem.weightCells) {
      c = "w";
      const rank = Math.floor(g / chips);
      if (pose.read > 0 && rank < pose.read * perChip + 0.5 && (!moe || hash(g) < readFrac)) read = true;
    } else if (g < mem.weightCells + K) {
      const i = g - mem.weightCells;
      if (i < prefixCells) c = pose.pre && i < myPrefix ? "pre" : "kv";
      else if (i < prefixCells + otherCells) c = "kv";
      else if (i < prefixCells + otherCells + mineCells) c = "me";
      else c = "free";
    }
    if (cell.dataset.c !== c) c ? (cell.dataset.c = c) : delete cell.dataset.c;
    if (read !== cell.hasAttribute("data-r")) read ? cell.setAttribute("data-r", "") : cell.removeAttribute("data-r");
  });
}

function draw() {
  const r = rig();
  const pose = state.pose;
  const T = {};
  for (const item of r.items) T[item.id] = offsetOf(r, item.asm);
  T.req = add(T.req, pose.req);
  for (const item of r.items) {
    const t = T[item.id];
    const node = r.nodes[item.id];
    const text = t[0] || t[1] || t[2] ? K.translateAlong(r.P, t) : "";
    if (node._t !== text) {
      text ? node.setAttribute("transform", text) : node.removeAttribute("transform");
      node._t = text;
    }
  }
  const keyed = r.items.map((item) => [item.id, item.key + dot(T[item.id], r.V)]).sort((a, b) => a[1] - b[1]);
  const order = keyed.map((entry) => entry[0]).join(",");
  if (order !== lastOrder) {
    const fragment = document.createDocumentFragment();
    keyed.forEach(([id]) => fragment.appendChild(r.nodes[id]));
    r.sorted.appendChild(fragment);
    lastOrder = order;
  }

  r.live("req").style.display = pose.reqOn ? "" : "none";
  r.queue.forEach((node, i) => (node.style.display = i < pose.queue ? "" : "none"));
  const key = cellKey(pose);
  if (key !== lastCells) {
    paintCells(r, pose);
    lastCells = key;
  }
  r.sms.forEach((node) => (pose.sm ? node.setAttribute("data-on", "") : node.removeAttribute("data-on")));
  const coreOn = (node) => {
    const id = node.dataset.core;
    if (!pose.core) return false;
    if (state.config.gpu === "l4") return id === pose.core;
    return (pose.core === "tok" && (id === "a0" || id === "a1")) || (pose.core === "sched" && (id === "b0" || id === "b1")) || (pose.core === "detok" && (id === "a8" || id === "a9"));
  };
  r.cores.forEach((node) => (coreOn(node) ? node.setAttribute("data-on", "") : node.removeAttribute("data-on")));
  r.l2.forEach((node) => (pose.l2 && !node.hasAttribute("data-slc") ? node.setAttribute("data-on", "") : node.removeAttribute("data-on")));
  r.mcs.forEach((node) => (pose.mc ? node.setAttribute("data-on", "") : node.removeAttribute("data-on")));

  const flows = r.FLOWS;
  const per = Math.floor(r.packets.length / flows.length);
  r.packets.forEach((node, i) => {
    if (!pose.flowOn) {
      if (node.style.display !== "none") node.style.display = "none";
      return;
    }
    const path = flows[i % flows.length];
    let t = (state.time * 1.26 + Math.floor(i / flows.length) / per) % 1;
    if (pose.flowDir < 0) t = 1 - t;
    const at = add(along(path, t), T.flow);
    node.style.display = "";
    node.setAttribute("transform", K.translateAlong(r.P, at));
  });
  r.pulses.forEach((node, i) => {
    if (!pose.launchOn) {
      if (node.style.display !== "none") node.style.display = "none";
      return;
    }
    const t = (state.time * 2.2 + i / r.pulses.length) % 1;
    node.style.display = "";
    node.setAttribute("transform", K.translateAlong(r.P, along(r.LAUNCH, t)));
  });

  for (const station of D.STATIONS) {
    const lamp = r.live(`lamp-${station}`);
    if (!lamp) continue;
    const wanted = pose.lamps[station] || "";
    if (lamp.dataset.state !== wanted) lamp.dataset.state = wanted;
  }

  const hotStations = new Set(pose.hot);
  if (state.selected) hotStations.add(state.selected);
  const hotItems = new Set();
  for (const station of hotStations) for (const id of r.HOT[station] || []) hotItems.add(id);
  if (hotStations.has("pool") || hotStations.has("weights")) r.items.forEach((item) => item.asm === "mem" && hotItems.add(item.id));
  if (state.selected === "package") ["substrate", "balls", "die", "sdie", "gdie"].forEach((id) => hotItems.add(id));
  if (state.selected === "cooler") hotItems.add("cooler");
  for (const item of r.items) {
    const node = r.nodes[item.id];
    const on = hotItems.has(item.id);
    if (on !== node.hasAttribute("data-hot")) on ? node.setAttribute("data-hot", "") : node.removeAttribute("data-hot");
  }
  const phone = narrow.matches;
  const layout = phone ? phoneLayout(r) : r.LABELS;
  const pills = layout.map((label) => {
    const home = K.iso(label.at, r.P);
    const moved = explodedAt(r, label);
    const text = (currentLang === "zh" && I18n.ZH_LABELS[r.name]?.[label.id]) || label.text;
    return Ink.pillSvg(moved, label.dx + home[0] - moved[0], label.dy + home[1] - moved[1], text, label.stations.some((s) => hotStations.has(s)) || state.selected === label.id, phone ? PHONE_PILL : undefined);
  }).join("");
  const box = phone ? PHONE_BOX : FULL_BOX;
  if (svg.getAttribute("viewBox") !== box) {
    svg.setAttribute("viewBox", box);
    lastPills = "";
  }
  if (pills !== lastPills) {
    pillLayer.innerHTML = pills;
    lastPills = pills;
  }
  drawGauge(pose);
  drawCut(r, pose);
  drawSound(r);
  drawDisplay(r, pose);
}

const cut = svg.querySelector("[data-cut]");
const cutWeights = Array.from(cut.querySelectorAll("[data-cw]"));
const cutKv = Array.from(cut.querySelectorAll("[data-ck]"));
const cutSm = cut.querySelector("[data-csm]");
const cutTok = cut.querySelector("[data-ctok]");
const cutLead = svg.querySelector("[data-clead]");
let lastCut = "";
function drawCut(r, pose) {
  const phone = narrow.matches;
  const origin = phone ? [356, 536] : [762, 300];
  const label = r.LABELS.find((l) => l.id === "pool");
  const anchor = explodedAt(r, label);
  const mix = state.mix || { K: 1, prefixCells: 0, myPrefix: 0, otherCells: 0, mineCells: 0 };
  const s = state.sim.serve;
  const ev = state.shown >= 0 ? state.sim.events[state.shown] : null;
  const key = [currentLang, phone, Math.round(anchor[0]), Math.round(anchor[1]), Math.round(pose.read * 13), pose.sm, mix.prefixCells, mix.myPrefix, mix.otherCells, mix.mineCells, ev ? ev.index : -1].join("|");
  if (key === lastCut) return;
  lastCut = key;
  cut.setAttribute("transform", `translate(${origin[0]} ${origin[1]})`);
  cutLead.setAttribute("d", `M${origin[0] + 116} ${origin[1]}L${anchor[0].toFixed(1)} ${anchor[1].toFixed(1)}`);
  cutWeights.forEach((node, i) => (i < Math.round(pose.read * cutWeights.length) ? node.setAttribute("data-r", "") : node.removeAttribute("data-r")));
  const scale = cutKv.length / mix.K;
  const pre = Math.round(mix.prefixCells * scale);
  const mine = Math.round(mix.myPrefix * scale);
  const other = Math.round(mix.otherCells * scale);
  const me = mix.mineCells ? Math.max(1, Math.round(mix.mineCells * scale)) : 0;
  cutKv.forEach((node, i) => {
    const c = i < pre ? (i < mine ? "pre" : "kv") : i < pre + other ? "kv" : i < pre + other + me ? "me" : "free";
    if (node.dataset.c !== c) node.dataset.c = c;
  });
  pose.sm ? cutSm.setAttribute("data-on", "") : cutSm.removeAttribute("data-on");
  let text = "";
  if (currentLang === "zh") {
    text = `KV 缓存池: 已使用 ${n(ev ? ev.poolUsed : 0)} / ${n(s.kvPagesTotal)} 个插槽`;
    if (ev && (ev.type === "decode" || ev.type === "decode-rest") && pose.sm) text = `结果: +${n(s.tokensPerStep)} 个 Token, +${n(s.tokensPerStep)} 个 KV 插槽`;
    else if (ev && ev.type === "prefill") text = `结果: 写入 ${n(ev.size)} 个 KV 插槽`;
    else if (ev && (ev.type === "decode" || ev.type === "decode-rest")) text = s.weightReadShare === null ? "原因: 流式读取批次选中的专家权重" : `原因: 本次权重读取占单步耗时的 ${n(s.weightReadShare * 100)}%`;
  } else {
    text = `KV pool: ${n(ev ? ev.poolUsed : 0)} of ${n(s.kvPagesTotal)} slots in use`;
    if (ev && (ev.type === "decode" || ev.type === "decode-rest") && pose.sm) text = `result: +${n(s.tokensPerStep)} token${s.tokensPerStep === 1 ? "" : "s"}, +${n(s.tokensPerStep)} KV slot${s.tokensPerStep === 1 ? "" : "s"}`;
    else if (ev && ev.type === "prefill") text = `result: ${n(ev.size)} KV slots written`;
    else if (ev && (ev.type === "decode" || ev.type === "decode-rest")) text = s.weightReadShare === null ? "cause: the weights of the picked experts stream in" : `cause: ${n(s.weightReadShare * 100)}% of the step is this read`;
  }
  cutTok.textContent = text;
}

const soundNode = svg.querySelector("[data-sound]");
let lastSound = "";
function drawSound(r) {
  const ev = state.shown >= 0 && !state.done && state.bi < state.beats.length ? state.sim.events[state.shown] : null;
  let word = "";
  let at = null;
  if (ev) {
    const step = M.STEPS[M.stepOf(ev.type)];
    word = ev.type === "queue" ? (currentLang === "zh" ? "等待…" : "wait...") : ev.type === "decode-rest" ? (currentLang === "zh" ? "呼 呼" : "whoosh whoosh") : step.sound;
    const station = { reuse: "pool", first: "sms" }[ev.type] || ev.station;
    const label = r.LABELS.find((l) => l.stations.includes(station)) || r.LABELS.find((l) => l.id === station);
    if (label) at = explodedAt(r, label);
  }
  const key = word && at ? `${word}|${Math.round(at[0])}|${Math.round(at[1])}` : "";
  if (key === lastSound) return;
  lastSound = key;
  soundNode.textContent = word;
  if (at) soundNode.setAttribute("transform", `translate(${(at[0] + 8).toFixed(1)} ${(at[1] - 14).toFixed(1)}) rotate(-8)`);
}

let lastDisplay = "";
function drawDisplay(r, pose) {
  const s = state.sim.serve;
  const ev = state.shown >= 0 ? state.sim.events[state.shown] : null;
  const used = ev ? ev.poolUsed : 0;
  const lines = currentLang === "zh"
    ? [s.tokS === null ? "tok/s  --" : `tok/s  ${s.tokS.toLocaleString("en-US")}`, `KV  ${Math.round((used / s.kvPagesTotal) * 100)}%  ${n(s.running)} 运行 ${n(s.waiting)} 排队`, `读取  ${n(pose.gbs)}/${s.peakGBs} GB/s`]
    : [s.tokS === null ? "tok/s  --" : `tok/s  ${s.tokS.toLocaleString("en-US")}`, `KV  ${Math.round((used / s.kvPagesTotal) * 100)}%  ${n(s.running)} run ${n(s.waiting)} wait`, `read  ${n(pose.gbs)}/${s.peakGBs} GB/s`];
  const key = lines.join("|") + r.name + currentLang;
  if (key === lastDisplay) return;
  lastDisplay = key;
  lines.forEach((text, i) => {
    const node = r.live(`lcd${i}`);
    if (node) node.textContent = text;
  });
}

let lastGauge = "";
function drawGauge(pose) {
  const peak = state.sim.decode.bandwidth;
  const value = Math.round(pose.gbs);
  const step = pose.stepT;
  const key = `${value}|${peak}|${Math.round(step * 100)}|${narrow.matches}|${currentLang}`;
  if (key === lastGauge) return;
  lastGauge = key;
  const f = clamp(value / peak, 0, 1);
  const angle = Math.PI * (1 - f);
  $("[data-gauge-needle]").setAttribute("x2", (70 + Math.cos(angle) * 44).toFixed(1));
  $("[data-gauge-needle]").setAttribute("y2", (92 - Math.sin(angle) * 44).toFixed(1));
  const end = [70 + Math.cos(angle) * 50, 92 - Math.sin(angle) * 50];
  $("[data-gauge-fill]").setAttribute("d", f > 0.001 ? `M20 92A50 50 0 0 1 ${end[0].toFixed(1)} ${end[1].toFixed(1)}` : "");
  $("[data-gauge-value]").textContent = value ? `${n(value)} GB/s` : state.sim.decode.effectiveGBs === null && state.sim.decode.tpot ? (currentLang === "zh" ? "未计算" : "not computed") : (currentLang === "zh" ? "空闲" : "idle");
  $("[data-gauge]").setAttribute("transform", narrow.matches ? "translate(196 532)" : "translate(6 4)");
  const cursor = $("[data-step-cursor]");
  cursor.style.left = step >= 0 ? `${(clamp(step, 0, 1) * 100).toFixed(1)}%` : "-10px";
  cursor.style.opacity = step >= 0 ? "1" : "0";
}

const SPRING = { stiffness: 64, damping: 14.2, stagger: 0.04 };
function stepExplode(dt) {
  let moving = false;
  Object.values(state.explode.shares).forEach((share, index) => {
    const goal = state.explode.target;
    if (still.matches) return Object.assign(share, { x: goal, v: 0 });
    if (share.goal !== goal) Object.assign(share, { goal, wait: index * SPRING.stagger });
    if (share.wait > 0) return (share.wait -= dt), (moving = true);
    for (let i = 0; i < 4; i++) {
      share.v += (SPRING.stiffness * (goal - share.x) - SPRING.damping * share.v) * (dt / 4);
      share.x += share.v * (dt / 4);
    }
    if (Math.abs(goal - share.x) < 5e-4 && Math.abs(share.v) < 5e-4) Object.assign(share, { x: goal, v: 0 });
    else moving = true;
  });
  return moving;
}

let frame = 0;
let last = 0;
let visible = true;
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
  last = now;
  if (state.playing) advance(dt * state.speed * (still.matches ? 40 : 1));
  const moving = stepExplode(dt);
  draw();
  frame = visible && (state.playing || moving) ? requestAnimationFrame(tick) : 0;
  if (!frame) last = 0;
}
function kick() {
  if (!frame && visible) frame = requestAnimationFrame(tick);
}
new IntersectionObserver((entries) => {
  visible = entries[entries.length - 1].isIntersecting;
  if (visible) kick();
}, { rootMargin: "120px 0px" }).observe(stage);

function play() {
  if (state.done) load(state.config);
  state.stopAt = -1;
  state.playing = true;
  state.explode.target = 0;
  syncButtons();
  kick();
}
function pause() {
  state.playing = false;
  syncButtons();
  kick();
}
function step() {
  if (state.done) load(state.config);
  state.explode.target = 0;
  state.stopAt = state.shown + 1;
  state.playing = true;
  syncButtons();
  kick();
}
let breakIndex = 0;
function breakOne() {
  const i = breakIndex % M.BREAKS.length;
  breakIndex += 1;
  load({ ...M.DEFAULTS, ...M.BREAKS[i] }, { autoplay: true });
  flash(currentLang === "zh" ? I18n.ZH_BREAK_NOTES[i] : C.BREAK_NOTES[i]);
}
function repair() {
  load(M.DEFAULTS, { autoplay: true });
  flash(currentLang === "zh" ? "已修复：L4、BF16、8 用户并发、正常散热、开启 CUDA Graphs 与 Radix 缓存。" : "Repaired: L4, BF16, 8 users, cool card, graphs and radix cache on.");
}
function toggleExplode() {
  state.explode.target = state.explode.target ? 0 : 1;
  if (state.explode.target) state.playing = false;
  syncButtons();
  kick();
}

const FRACTION_TEXT_EN = { "0.85": "0.85 (kit default)", "0.74": "0.74 (smaller)", "0.7": "0.70 (kit default)", "0.82": "0.82 (larger)" };
const FRACTION_TEXT_ZH = { "0.85": "0.85 (默认推荐)", "0.74": "0.74 (较小池)", "0.7": "0.70 (默认推荐)", "0.82": "0.82 (较大池)" };
function syncControls() {
  const c = state.config;
  $("#gm-gpu").value = c.gpu;
  $("#gm-dtype").value = c.dtype;
  const frac = $("#gm-frac");
  const fracMap = currentLang === "zh" ? FRACTION_TEXT_ZH : FRACTION_TEXT_EN;
  const wanted = M.FRACTIONS[c.gpu].map((value) => `<option value="${value}">${fracMap[value] || value}</option>`).join("");
  if (frac.dataset.gpu !== c.gpu || frac.dataset.lang !== currentLang) {
    frac.innerHTML = wanted;
    frac.dataset.gpu = c.gpu;
    frac.dataset.lang = currentLang;
  }
  frac.value = c.frac;
  $("#gm-graphs").checked = c.graphs;
  $("#gm-workload").value = c.workload;
  $("#gm-users").value = String(M.USERS.indexOf(c.users));
  $("[data-gm-users-out]").textContent = String(c.users);
  $("#gm-shared").value = String(c.shared);
  $("#gm-radix").checked = c.radix;
  $("#gm-clock").checked = c.clock === "hot";
  $("#gm-clock").disabled = c.gpu !== "l4";
  $("[data-gm-users-wrap]").hidden = c.workload !== "unique";
  $("[data-gm-shared-wrap]").hidden = c.workload !== "shared";
  renderStatic();
}
function syncButtons() {
  if (state.sim) syncSteps();
  const run = $("[data-gm-run]");
  if (currentLang === "zh") {
    run.textContent = state.playing ? "暂停" : state.done ? "重新运行" : state.shown >= 0 ? "继续" : "运行";
    $("[data-gm-explode]").textContent = state.explode.target ? "组装还原" : "爆炸分解";
  } else {
    run.textContent = state.playing ? "Pause" : state.done ? "Run again" : state.shown >= 0 ? "Resume" : "Run";
    $("[data-gm-explode]").textContent = state.explode.target ? "Assemble" : "Explode";
  }
  run.setAttribute("aria-pressed", String(state.playing));
  $("[data-gm-explode]").setAttribute("aria-pressed", String(Boolean(state.explode.target)));
}
function writeUrl() {
  const params = new URLSearchParams(M.encode(state.config));
  if (document.documentElement.classList.contains("iso-nolabels")) params.set("labels", "0");
  if (palette !== "green") params.set("pal", palette);
  if (currentLang !== "en") params.set("lang", currentLang);
  const query = params.toString();
  const keep = /[?&]still\b/.test(location.search) ? (query ? "&still" : "still") : "";
  history.replaceState(null, "", location.pathname + (query || keep ? "?" + query + keep : "") + location.hash);
}
let flashTimer = 0;
function flash(text) {
  const node = $("[data-gm-flash]");
  node.textContent = text;
  node.dataset.on = "";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => delete node.dataset.on, 3200);
}

function localizeBasis(basis) {
  if (!basis) return "";
  if (basis.includes("every weight, every step")) return "每步读取全部权重";
  if (basis.includes("estimate: about 3 billion active parameters")) return "估算：每个 Token 约 30 亿激活参数";
  if (basis.includes("not computed")) return "未计算：每个 Token 独立选取专家，每步读取字节数未予实测";
  return basis;
}
function localizeOutcome(sim) {
  if (currentLang !== "zh") return sim.outcome.text;
  const { config, outcome } = sim;
  const { status } = outcome;
  const adm = sim.admission;
  const pool = sim.pool;
  const point = sim.point;
  const parts = [];
  if (status === "served") parts.push("无等待直接提供服务。");
  if (adm.queued > 0) parts.push(`容量为 ${n(pool)} Token 的显存池可容纳 ${n(adm.fits)} 个请求，因此 ${n(adm.users)} 位用户中有 ${n(adm.queued)} 位需排队等待。`);
  if (status === "recomputed") parts.push(config.radix ? "共享前缀超出了显存池容纳上限，因此每个请求都必须重新计算前缀。" : "由于禁用了 Radix 缓存，每个请求都必须重新计算共享前缀。");
  if (config.clock === "hot") parts.push("加速卡温度过高，触发硬件降频保护。");
  parts.push(point ? `实测：输出吞吐量 ${point.tokS.toLocaleString("en-US")} tok/s，首字延迟中位数 ${point.ttft.toLocaleString("en-US")} ms，单 Token 耗时中位数 ${point.tpot.toLocaleString("en-US")} ms。` : "当前配置未进行实测，因此页面仅显示理论数值而无实测速度。");
  return parts.join(" ");
}

const ms = (value) => (value === null || value === undefined ? (currentLang === "zh" ? "未实测" : "not measured") : `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ms`);
function renderStatic() {
  const sim = state.sim;
  const c = sim.config;
  const dec = sim.decode;
  const mem = sim.memory;
  const point = sim.point;
  $("[data-gm-model]").textContent = `${D.machine[c.gpu].model} · ${c.dtype.toUpperCase()} · ${D.specs[c.gpu].name}`;
  const work = currentLang === "zh"
    ? (c.workload === "unique" ? `${n(c.users)} 位并发用户，512 输入 Token，128 输出 Token` : `8 位用户，4 组并发，${n(c.shared)} Token 共享系统提示词，128 Token 提问，64 输出 Token`)
    : (c.workload === "unique" ? `${n(c.users)} user${c.users === 1 ? "" : "s"}, 512 tokens in, 128 out` : `8 users, 4 groups, a ${n(c.shared)}-token shared system prompt, 128-token question, 64 out`);
  $("[data-gm-work]").textContent = work;
  const read = dec.readGB === null ? "the experts that the batch picks" : D.dense[c.gpu] ? `${dec.readGB.toLocaleString("en-US")} GB` : `about ${dec.readGB.toLocaleString("en-US")} GB (an estimate from about 3 billion active parameters)`;
  const readZh = dec.readGB === null ? "批次激活的专家权重" : D.dense[c.gpu] ? `${dec.readGB.toLocaleString("en-US")} GB` : `约 ${dec.readGB.toLocaleString("en-US")} GB (由约 30 亿激活参数估算)`;
  if (currentLang === "zh") {
    $("[data-step-text]").innerHTML = dec.floorMs !== null && dec.tpot
      ? `单个 Decode 步骤：实测 <strong>${ms(dec.tpot)}</strong>。以 ${dec.bandwidth} GB/s 显存峰值带宽读取 ${readZh} 至少需耗时 <strong>${ms(dec.floorMs)}</strong>，因此读取权重占单步耗时的 <strong>${Math.round(dec.share * 100)}%</strong>。${sim.launch ? ` 未开启 CUDA Graphs 时每步耗时${sim.launch.delta >= 0 ? `增加 ${ms(sim.launch.delta)}` : `减少 ${ms(-sim.launch.delta)}`}。` : ""}`
      : dec.tpot
        ? `单个 Decode 步骤：实测 <strong>${ms(dec.tpot)}</strong>。${escapeHtml(localizeBasis(dec.basis))}。`
        : `当前配置未进行实测，因此未显示单步耗时。${escapeHtml(localizeBasis(dec.basis))}。`;
  } else {
    $("[data-step-text]").innerHTML = dec.floorMs !== null && dec.tpot
      ? `One decode step: <strong>${ms(dec.tpot)}</strong> measured. Reading ${read} at the peak ${dec.bandwidth} GB/s takes at least <strong>${ms(dec.floorMs)}</strong>, so the weight read is <strong>${Math.round(dec.share * 100)}%</strong> of the step.${sim.launch ? ` Without CUDA graphs the step was ${sim.launch.delta >= 0 ? `${ms(sim.launch.delta)} longer` : `${ms(-sim.launch.delta)} shorter`}.` : ""}`
      : dec.tpot
        ? `One decode step: <strong>${ms(dec.tpot)}</strong> measured. ${escapeHtml(dec.basis[0].toUpperCase() + dec.basis.slice(1))}.`
        : `This setting was not measured, so the page shows no step time. ${escapeHtml(dec.basis[0].toUpperCase() + dec.basis.slice(1))}.`;
  }
  $("[data-step-read]").style.width = dec.share !== null ? `${(dec.share * 100).toFixed(1)}%` : "0%";
  $("[data-step-rest]").style.width = dec.share !== null ? `${((1 - dec.share) * 100).toFixed(1)}%` : dec.tpot ? "100%" : "0%";
  $("[data-gauge-peak]").textContent = currentLang === "zh" ? `峰值 ${dec.bandwidth} GB/s` : `of ${dec.bandwidth} GB/s peak`;
  const tpc = sim.pool / mem.kvCells;
  const memRows = currentLang === "zh"
    ? [
        ["w", "模型权重", `${mem.weightsGiB} GB`, `${mem.weightCells} 个单元`],
        ["kv", "KV 缓存池", `${mem.kvGiB} GB，${n(sim.pool)} Token`, `${mem.kvCells} 个单元，每单元约 ${n(tpc)} Token`],
        ["rest", "运行时、Graphs 与空闲", `${mem.restGiB} GB`, `${mem.restCells} 个单元`],
      ]
    : [
        ["w", "Weights", `${mem.weightsGiB} GB`, `${mem.weightCells} cells`],
        ["kv", "KV pool", `${mem.kvGiB} GB, ${n(sim.pool)} tokens`, `${mem.kvCells} cells, about ${n(tpc)} tokens each`],
        ["rest", "Runtime, graphs and free", `${mem.restGiB} GB`, `${mem.restCells} cells`],
      ];
  $("[data-gm-memory]").innerHTML = memRows.map(([k, name, size, cells]) => `<li><i class="gm-key" data-c="${k}"></i><span><strong>${name}</strong> ${escapeHtml(size)}</span><span>${escapeHtml(cells)}</span></li>`).join("");
  $("[data-gm-memory-note]").textContent = currentLang === "zh"
    ? `驱动报告的显存总量为 ${mem.totalGiB} GB，在 ${D.rigs[c.gpu].CHIPS} 颗芯片封装上绘制为 ${mem.cells} 个单元。每个封装芯片都持有所有显存区域的一部分切片，因为显存控制器在所有通道之间对地址进行交错编址。容量数值来自 SGLang 启动日志；GB 单位与 SGLang 输出保持一致。`
    : `${mem.totalGiB} GB of memory as the driver reports it, drawn as ${mem.cells} cells over ${D.rigs[c.gpu].CHIPS} packages. Every package holds a slice of every region, because the memory controllers interleave addresses across the channels. Sizes are from the startup logs; the GB unit is the one SGLang prints.`;
  const outcome = sim.outcome;
  $("[data-gm-outcome]").textContent = localizeOutcome(sim);
  const status = $("[data-gm-status]");
  const statusZh = { served: "正常服务", queued: "排队等待", recomputed: "重算前缀", throttled: "过热降频" }[outcome.status] || outcome.status;
  status.textContent = currentLang === "zh" ? statusZh : outcome.status;
  status.dataset.status = outcome.status;
  $("[data-gm-measured]").textContent = currentLang === "zh"
    ? (point ? `实测运行：${sim.run.set === "l4-hot" ? "L4 过热测试组" : sim.run.set === "l4" ? "L4 正常测试组" : "GB10 测试组"}，${sim.run.key}，三次运行取中位数。` : "无完全匹配此配置的实测运行。缓存池大小与理论参数仍基于真实日志。")
    : (point ? `Measured run: ${sim.run.set === "l4-hot" ? "the hot L4 sweep" : sim.run.set === "l4" ? "the cooled L4 sweep" : "the GB10 sweep"}, ${sim.run.key}, three seeds, median shown.` : "No run matches this setting. The pool and the arithmetic still come from the logs.");
}

const stepButtons = $$("[data-gm-stepbtn]");
const renderMode = /[?&]render\b/.test(location.search);
if (renderMode) document.documentElement.setAttribute("data-render", "");
let mode = "manual";
try {
  mode = localStorage.getItem("gm-mode") === "auto" ? "auto" : "manual";
} catch (error) {}
if (renderMode) mode = "manual";
function stepLast(index) {
  let last = -1;
  state.sim.events.forEach((ev, i) => M.stepOf(ev.type) === index && (last = i));
  return last;
}
function syncSteps() {
  const beats = state.beats;
  const bi = state.bi;
  const steps = state.beatStep;
  const active = bi < beats.length && (state.playing || state.bt > 0) ? steps[bi] : -1;
  const next = active >= 0 ? active : bi < beats.length ? steps[bi] : -1;
  stepButtons.forEach((button, i) => {
    const last = steps.lastIndexOf(i);
    const status = i === active ? "running" : i === next ? "next" : last < bi ? "done" : "later";
    if (button.dataset.status !== status) button.dataset.status = status;
    button.disabled = mode === "auto" || status === "done" || status === "later" || (status === "running" && state.playing);
    button.setAttribute("aria-current", i === active ? "step" : "false");
  });
  const current = active >= 0 ? active : next >= 0 ? next : M.STEPS.length - 1;
  const step = M.STEPS[current];
  const shown = state.shown;
  $("[data-gm-hint]").textContent = currentLang === "zh" ? I18n.ZH_STEP_HINTS[current] : `${current + 1}. ${step.hint}`;
  $("[data-gm-badge]").textContent = state.done ? (currentLang === "zh" ? "完成" : "done") : shown >= 0 ? (currentLang === "zh" && !state.timing[shown] ? "未计时" : badgeOf(state.timing[shown])) : (currentLang === "zh" ? "就绪" : "ready");
  $$("[data-gm-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.gmMode === mode)));
}
function playStep(index) {
  if (state.done) load(state.config);
  state.explode.target = 0;
  state.stopAt = stepLast(index);
  state.playing = true;
  syncButtons();
  kick();
}
stepButtons.forEach((button) => button.addEventListener("click", () => playStep(Number(button.dataset.gmStepbtn))));
$$("[data-gm-mode]").forEach((button) =>
  button.addEventListener("click", () => {
    mode = button.dataset.gmMode;
    try {
      localStorage.setItem("gm-mode", mode);
    } catch (error) {}
    if (mode === "auto") play();
    else pause();
    syncSteps();
  }),
);
$("[data-gm-restart]").addEventListener("click", (event) => {
  event.preventDefault();
  state.explode.target = 0;
  load(state.config);
  mode === "auto" ? play() : syncSteps();
});

function localizeEventType(type) {
  const map = {
    arrive: "到达",
    tokenize: "分词",
    match: "前缀匹配",
    queue: "排队",
    admit: "准入",
    send: "总线传输",
    reuse: "复用前缀",
    prefill: "Prefill 预填充",
    first: "首个 Token",
    decode: "Decode 解码",
    "decode-rest": "后续 Decode",
    detok: "反分词",
    exit: "退出",
  };
  return map[type] || type;
}

function localizeTrace(item) {
  const sim = state.sim;
  if (!sim) return item.trace;
  const { config, admission: adm, pool, point, decode: dec } = sim;
  const m = D.machine[config.gpu];
  const shared = config.workload === "shared";
  const SHOWN_STEPS = 3;

  switch (item.type) {
    case "arrive":
      return config.gpu === "l4"
        ? "请求通过网络到达主机 CPU"
        : "请求通过网络到达 CPU 芯粒";
    case "tokenize":
      return shared
        ? `分词器将文本转换为 ${n(adm.input)} 个 Token ID：${n(config.shared)} 个系统提示词 Token 与 128 个问题 Token`
        : `分词器将文本转换为 ${n(adm.input)} 个 Token ID`;
    case "match":
      if (!config.radix) {
        return "Radix 缓存已禁用，调度器无法命中前缀：整个提示词需重新计算";
      } else if (adm.prefixFits) {
        return `Radix 树在 ${n(adm.input)} 个 Token 中命中了 ${n(adm.matched)} 个：4 个系统提示词 (${n(adm.prefix)} Token) 保留在池中`;
      } else {
        return `4 个系统提示词需 ${n(adm.prefix)} Token，运行中请求需 ${n(8 * (128 + 64))} Token，超出容量 ${n(pool)} Token 的显存池，前缀被迫淘汰：命中 0 个 Token`;
      }
    case "queue":
      return `显存池仅可容纳 ${n(adm.fits)} 个 ${n(adm.need)} Token 的请求，因此 ${n(adm.running)} 个请求正在运行，${n(adm.queued)} 个请求排队：当前请求等待空闲插槽`;
    case "admit":
      return `准入执行：预留 ${n(adm.need)} 个 Token，显存池已使用 ${n(item.poolUsed)} / ${n(pool)} Token (${Math.round((item.poolUsed / pool) * 100)}%)，${n(adm.running)} 个请求运行中`;
    case "send":
      return config.gpu === "l4"
        ? `${n(adm.input)} 个 Token ID 经由 ${m.link} 从主机传输到 GPU`
        : `Token ID 保留在共享的 LPDDR5X 统一内存中：GPU 芯粒通过 ${m.link} 直接读取`;
    case "reuse":
      return `${n(adm.matched)} 个前缀 Token 已存在于显存池中：SM 张量核心无需重复计算`;
    case "prefill":
      return item.chunks && item.chunks > 1
        ? `Prefill 预填充分块 ${item.index} / ${item.chunks}：${n(item.size)} 个 Token 流经张量核心；其 Key 和 Value 写入缓存池`
        : `Prefill 预填充：${n(item.size)} 个 Token 流经张量核心；其 Key 和 Value 写入缓存池`;
    case "first":
      return point
        ? `最后一次 Prefill 传递生成首个 Token，首字延迟 ${ms(point.ttft)}（中位数，实测）`
        : `最后一次 Prefill 传递生成首个 Token；当前配置未进行实测`;
    case "decode": {
      const readZh = dec.readGB === null
        ? "批次激活的专家权重"
        : D.dense[config.gpu]
          ? `${dec.readGB.toLocaleString("en-US")} GB`
          : `约 ${dec.readGB.toLocaleString("en-US")} GB (估算)`;
      const tailZh = point ? `单步耗时 ${ms(point.tpot)}（中位数，实测）` : "未实测";
      return `Decode 步骤 ${item.step}：SM 通过 L2 读取 ${readZh}，为每个运行中请求生成 ${n(dec.tokensPerStep)} 个 Token；${tailZh}`;
    }
    case "decode-rest": {
      const more = adm.output - 1 - SHOWN_STEPS;
      return `Decode 步骤 ${SHOWN_STEPS + 1} 至 ${adm.output - 1}：${D.dense[config.gpu] ? "完全相同的权重读取" : "相同类型的解码步骤"}重复执行 ${more} 次`;
    }
    case "detok":
      return `反分词器将 ${n(adm.output)} 个 Token ID 转换回文本并流式推送返回`;
    case "exit": {
      const statusZh = { served: "正常完成", queued: "排队等待", recomputed: "重算前缀", throttled: "过热降频" }[item.outcome.status] || item.outcome.status;
      return `退出：${statusZh}${point ? `，针对 ${adm.users === 1 ? "单个用户" : `全部 ${n(adm.users)} 位用户`} 的输出吞吐为 ${point.tokS.toLocaleString("en-US")} tok/s` : "，未实测"}`;
    }
    default:
      return item.trace;
  }
}

function render(index) {
  const sim = state.sim;
  const ev = index < 0 ? null : sim.events[index];
  const c = sim.config;
  const point = sim.point;
  const corner = document.querySelector("[data-readout]");
  if (corner) {
    if (currentLang === "zh") {
      corner.textContent = ev ? `步骤 ${ev.index + 1} / ${sim.events.length} · ${localizeEventType(ev.type)}` : `就绪 · 共 ${sim.events.length} 步`;
    } else {
      corner.textContent = ev ? `step ${ev.index + 1} of ${sim.events.length} · ${ev.type}` : `ready · ${sim.events.length} steps`;
    }
  }
  const names = currentLang === "zh" ? I18n.ZH_NAMES : C.NAMES;
  const stationName = ev ? (pick(names[ev.station], c.gpu) || ev.station) : "";
  $("[data-gm-stage-name]").textContent = ev ? `${stationName} · ${currentLang === "zh" ? localizeTrace(ev) : ev.trace}` : (currentLang === "zh" ? "就绪 · 点击运行" : "Ready · press Run");
  const sv = sim.serve;
  const used = ev ? ev.poolUsed : 0;
  if (currentLang === "zh") {
    $("[data-gm-pool]").textContent = `${n(used)} / ${n(sv.kvPagesTotal)} Token · ${Math.round((used / sv.kvPagesTotal) * 100)}%`;
    $("[data-gm-running]").textContent = `${n(sv.running)} 运行中 · ${n(sv.waiting)} 排队等待`;
    $("[data-gm-tps]").textContent = `每步 ${n(sv.tokensPerStep)} Token`;
    $("[data-gm-share]").textContent = sv.weightReadShare !== null ? `占单步耗时 ${Math.round(sv.weightReadShare * 100)}%` : "未计算";
    $("[data-gm-tpot]").textContent = ms(sv.stepMs);
    $("[data-gm-toks]").textContent = sv.tokS !== null ? `${sv.tokS.toLocaleString("en-US")} tok/s` : "未实测";
    $("[data-gm-ttft]").textContent = ms(sv.firstTokenMs);
    $("[data-gm-clock]").textContent = point && point.smMhz ? `${n(point.smMhz)} MHz SM · ${point.maxTemp} ℃` : c.clock === "hot" ? "360 MHz SM · 87 ℃ (nvidia-smi)" : "未记录";
  } else {
    $("[data-gm-pool]").textContent = `${n(used)} of ${n(sv.kvPagesTotal)} tokens · ${Math.round((used / sv.kvPagesTotal) * 100)}%`;
    $("[data-gm-running]").textContent = `${n(sv.running)} running · ${n(sv.waiting)} held back`;
    $("[data-gm-tps]").textContent = `${n(sv.tokensPerStep)} per step`;
    $("[data-gm-share]").textContent = sv.weightReadShare !== null ? `${Math.round(sv.weightReadShare * 100)}% of the step` : "not computed";
    $("[data-gm-tpot]").textContent = ms(sv.stepMs);
    $("[data-gm-toks]").textContent = sv.tokS !== null ? `${sv.tokS.toLocaleString("en-US")} tok/s` : "not measured";
    $("[data-gm-ttft]").textContent = ms(sv.firstTokenMs);
    $("[data-gm-clock]").textContent = point && point.smMhz ? `${n(point.smMhz)} MHz SM · ${point.maxTemp} C` : c.clock === "hot" ? "360 MHz SM · 87 C (nvidia-smi)" : "not recorded";
  }
  const list = $("[data-gm-trace]");
  list.innerHTML = sim.events.slice(0, index + 1).map((item) => {
    const traceText = currentLang === "zh" ? localizeTrace(item) : item.trace;
    const atText = currentLang === "zh" ? "耗时" : "at";
    return `<li data-type="${item.type}"><span class="gm-n">${String(item.index + 1).padStart(2, "0")}</span><span class="gm-t">${item.type}</span><span class="gm-d">${escapeHtml(traceText)}${item.clock !== null && item.clock !== undefined ? ` <em>${atText} ${n(item.clock)} ms</em>` : ""}</span></li>`;
  }).join("");
  list.scrollTop = list.scrollHeight;
  syncSteps();
}

$("[data-gm-run]").addEventListener("click", () => (state.playing ? pause() : play()));
$("[data-gm-step]").addEventListener("click", step);
$("[data-gm-break]").addEventListener("click", breakOne);
$("[data-gm-repair]").addEventListener("click", repair);
$("[data-gm-explode]").addEventListener("click", toggleExplode);
$("[data-gm-reset]").addEventListener("click", () => {
  state.explode.target = 0;
  inspect(null);
  load(M.DEFAULTS);
  kick();
});
const configFromForm = () => ({ gpu: $("#gm-gpu").value, dtype: $("#gm-dtype").value, frac: $("#gm-gpu").value === $("#gm-frac").dataset.gpu ? $("#gm-frac").value : undefined, graphs: $("#gm-graphs").checked, workload: $("#gm-workload").value, users: M.USERS[Number($("#gm-users").value)], shared: Number($("#gm-shared").value), radix: $("#gm-radix").checked, clock: $("#gm-clock").checked ? "hot" : "cool" });
["#gm-gpu", "#gm-dtype", "#gm-frac", "#gm-graphs", "#gm-workload", "#gm-shared", "#gm-radix", "#gm-clock"].forEach((selector) => $(selector).addEventListener("change", () => load(configFromForm(), { autoplay: state.playing || state.shown >= 0 })));
$("#gm-users").addEventListener("input", () => load(configFromForm(), { autoplay: state.playing || state.shown >= 0 }));
$$("[data-gm-speed]").forEach((button) =>
  button.addEventListener("click", () => {
    state.speed = Number(button.dataset.gmSpeed);
    $$("[data-gm-speed]").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
  }),
);
$$("[data-gm-scenario]").forEach((button) =>
  button.addEventListener("click", () => {
    load({ ...M.DEFAULTS, ...JSON.parse(button.dataset.gmScenario) }, { autoplay: true });
    $$("[data-gm-scenario]").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    showTab("run");
  }),
);
$("[data-gm-copy]").addEventListener("click", async () => {
  const url = location.href.replace(/([?&])still\b&?/, "$1").replace(/[?&]$/, "");
  try {
    await navigator.clipboard.writeText(url);
    flash(currentLang === "zh" ? "链接已复制，打开即为此配置。" : "Link copied. It opens with these switches set.");
  } catch (error) {
    flash(url);
  }
});

function showTab(name) {
  $$("[data-gm-tab]").forEach((tab) => {
    const on = tab.dataset.gmTab === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  $$("[data-gm-panel]").forEach((panel) => (panel.hidden = panel.dataset.gmPanel !== name));
}
$$("[data-gm-tab]").forEach((tab, index, tabs) => {
  tab.addEventListener("click", () => showTab(tab.dataset.gmTab));
  tab.addEventListener("keydown", (event) => {
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!move) return;
    event.preventDefault();
    const next = tabs[(index + move + tabs.length) % tabs.length];
    showTab(next.dataset.gmTab);
    next.focus();
  });
});

const PART_OF = { port: "ingress", socket: "scheduler", ihs: "scheduler", hostdie: "scheduler", lanes: "link", riser: "link", c2c: "link", die: "sms", gdie: "sms", sdie: "scheduler", substrate: "package", balls: "package", bumps: "package", cooler: "cooler", card: "package", vrm: "package", bracket: "package", plate: null, req: null, queue: "scheduler", flow: "weights", launch: "link" };
function inspect(part) {
  state.selected = part;
  const panel = $("[data-gm-inspect]");
  const gpu = state.config.gpu;
  const info = part ? (currentLang === "zh" ? I18n.ZH_INFO[part] : C.INFO[part]) : null;
  const names = currentLang === "zh" ? I18n.ZH_NAMES : C.NAMES;
  $$("[data-gm-part]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.gmPart === part)));
  if (!info) {
    panel.innerHTML = `<p class="gm-muted">${currentLang === "zh" ? I18n.ZH_UI.inspectEmpty : "Select a part of the machine, or pick one from the list, to see what it does for one request."}</p>`;
    kick();
    return;
  }
  const whatItDoes = currentLang === "zh" ? "功能职责" : "What it does";
  const whyItMatters = currentLang === "zh" ? "关键意义" : "Why it matters";
  const withoutIt = currentLang === "zh" ? "如果缺少" : "Without it";
  panel.innerHTML = `<p class="gm-label">${escapeHtml(pick(names[part], gpu))}</p><h3>${escapeHtml(pick(info.name, gpu))}</h3><p class="gm-kicker">${escapeHtml(pick(info.is, gpu))}</p><dl><dt>${whatItDoes}</dt><dd>${escapeHtml(pick(info.does, gpu))}</dd><dt>${whyItMatters}</dt><dd>${escapeHtml(pick(info.why, gpu))}</dd><dt>${withoutIt}</dt><dd>${escapeHtml(pick(info.without, gpu))}</dd></dl><a class="gm-lesson" href="${info.lesson.href}">${escapeHtml(info.lesson.title)} →</a>`;
  kick();
}
$$("[data-gm-part]").forEach((button) => button.addEventListener("click", () => inspect(state.selected === button.dataset.gmPart ? null : button.dataset.gmPart)));
svg.addEventListener("click", (event) => {
  const node = event.target.closest("g[data-i]");
  if (!node) return;
  const id = node.dataset.i;
  let part = PART_OF[id];
  if (part === undefined) part = /^chip/.test(id) ? "pool" : /^lamp-/.test(id) ? id.slice(5) : null;
  if (!part || !C.INFO[part]) return;
  inspect(state.selected === part ? null : part);
  showTab("inspect");
});
stage.addEventListener("keydown", (event) => {
  if (event.target !== stage) return;
  const key = event.key.toLowerCase();
  if (key === " " || key === "enter") state.playing ? pause() : play();
  else if (key === "arrowright") step();
  else if (key === "e") toggleExplode();
  else if (key === "b") breakOne();
  else if (key === "r") repair();
  else return;
  event.preventDefault();
});

const PALETTES = D.PALETTES;
const figure = document.querySelector(".gm-figure");
const query = new URLSearchParams(location.search);
let palette = PALETTES[query.get("pal")] ? query.get("pal") : "green";
function paint() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const [l, m, d] = PALETTES[palette].map((hex) => (dark ? Ink.blend(hex, "#1f1c18", 0.38) : hex));
  figure.style.setProperty("--body-l", l);
  figure.style.setProperty("--body-m", m);
  figure.style.setProperty("--body-d", d);
  $$("[data-gm-pal]").forEach((button) => {
    button.style.background = PALETTES[button.dataset.gmPal][1];
    button.setAttribute("aria-pressed", String(button.dataset.gmPal === palette));
  });
}
$$("[data-gm-pal]").forEach((button) => button.addEventListener("click", () => ((palette = button.dataset.gmPal), paint(), writeUrl())));
new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
paint();
const wobble = svg.querySelector("[data-wobble]");
function setWobble(value) {
  wobble.setAttribute("scale", String(value));
  Object.values(RIGS).forEach((r) => {
    const layer = r.layer.querySelector("[data-layer]");
    value > 0 ? layer.setAttribute("filter", "url(#gm-hand)") : layer.removeAttribute("filter");
  });
}
$("#gm-wobble").addEventListener("input", (event) => setWobble(Number(event.target.value)));
function setLabels(on) {
  document.documentElement.classList.toggle("iso-nolabels", !on);
  $("#gm-labels").checked = on;
  writeUrl();
}
$("#gm-labels").addEventListener("change", (event) => setLabels(event.target.checked));
if (query.get("labels") === "0") document.documentElement.classList.add("iso-nolabels"), ($("#gm-labels").checked = false);

function renderSpecs() {
  const panel = $("#gm-panel-specs");
  if (!panel) return;
  const s_l4 = Hw.SPECS.l4;
  const s_gb10 = Hw.SPECS.gb10;
  const DOCS_EN = { l4Page: "NVIDIA L4 product page", l4Brief: "NVIDIA L4 product brief PB-11316-001", ada: "NVIDIA Ada GPU architecture whitepaper", sparkPage: "NVIDIA DGX Spark product page", sparkGuide: "NVIDIA DGX Spark user guide", gb10HotChips: "NVIDIA GB10 talk, Hot Chips 2025" };
  const docs = currentLang === "zh" ? I18n.ZH_DOCS : DOCS_EN;

  const specRows = (gpu) => {
    const s = gpu === "l4" ? s_l4 : s_gb10;
    const labels = currentLang === "zh" ? I18n.ZH_SPECS_LABELS[gpu] : null;
    let rows;
    if (gpu === "l4") {
      rows = currentLang === "zh"
        ? [
            [labels["Die"], s.architecture],
            [labels["SMs"], s.sms, `${s.gpcs.value} GPC，${s.tpcs.value} TPC`],
            [labels["Tensor Cores"], s.tensorCores, `每 SM 4 个，${s.tensorGen.value}`],
            [labels["L2 cache"], s.l2MB, "MB"],
            [labels["Memory"], s.memory],
            [labels["Bus"], s.busBits, "位，32 位控制器"],
            [labels["Bandwidth"], s.bandwidthGBs, "GB/s 峰值"],
            [labels["Host link"], s.interconnect],
            [labels["Power"], s.tdpW, "W，被动散热"],
            [labels["Clocks"], s.clocksMHz, "MHz"],
          ]
        : [
            ["Die", s.architecture],
            ["SMs", s.sms, `${s.gpcs.value} GPCs, ${s.tpcs.value} TPCs`],
            ["Tensor Cores", s.tensorCores, `4 per SM, ${s.tensorGen.value}`],
            ["L2 cache", s.l2MB, "MB"],
            ["Memory", s.memory],
            ["Bus", s.busBits, "bits, 32-bit controllers"],
            ["Bandwidth", s.bandwidthGBs, "GB/s peak"],
            ["Host link", s.interconnect],
            ["Power", s.tdpW, "W, passive cooling"],
            ["Clocks", s.clocksMHz, "MHz"],
          ];
    } else {
      rows = currentLang === "zh"
        ? [
            [labels["Chip"], s.architecture],
            [labels["CPU"], s.cpu],
            [labels["GPU"], s.cudaCores, `CUDA 核心，${s.tensorGen.value} Tensor Core；SM 数量未公布`],
            [labels["GPU L2"], s.l2MB, "MB"],
            [labels["CPU caches"], s.cpuL3MB, `MB L3，外加 ${s.slcMB.value} MB 系统级缓存`],
            [labels["Memory"], s.memory],
            [labels["Bus"], s.busBits, `位，${s.channels.value} 个通道`],
            [labels["Bandwidth"], s.bandwidthGBs, "GB/s 峰值"],
            [labels["Chip link"], s.interconnect, `GPU 独享带宽 ${s.c2cGBs.value} GB/s`],
            [labels["Power"], s.tdpW, "W 芯片总功耗"],
          ]
        : [
            ["Chip", s.architecture],
            ["CPU", s.cpu],
            ["GPU", s.cudaCores, `CUDA cores, ${s.tensorGen.value} Tensor Cores; SM count not published`],
            ["GPU L2", s.l2MB, "MB"],
            ["CPU caches", s.cpuL3MB, `MB L3, plus a ${s.slcMB.value} MB system level cache`],
            ["Memory", s.memory],
            ["Bus", s.busBits, `bits, ${s.channels.value} channels`],
            ["Bandwidth", s.bandwidthGBs, "GB/s peak"],
            ["Chip link", s.interconnect, `${s.c2cGBs.value} GB/s for the GPU`],
            ["Power", s.tdpW, "W for the chip"],
          ];
    }
    return rows.map(([label, entry, unit]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(entry.value).toLocaleString("en-US"))}${unit ? ` ${escapeHtml(unit)}` : ""}<small>${escapeHtml(docs[entry.source])}, ${escapeHtml(entry.where)}</small></dd>`).join("");
  };

  const abstract = (gpu) => {
    const list = currentLang === "zh" ? I18n.ZH_ABSTRACT[gpu] : Hw.ABSTRACT[gpu];
    return list.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  };

  const sourceLine = currentLang === "zh"
    ? I18n.ZH_UI.sourceLine
    : "Hardware sources: the NVIDIA L4 product page and product brief, the NVIDIA Ada GPU architecture whitepaper, the NVIDIA DGX Spark product page and user guide, and the NVIDIA GB10 talk at Hot Chips 2025.";

  panel.innerHTML = `
    <p class="gm-label">NVIDIA L4</p>
    <dl class="gm-specs">${specRows("l4")}</dl>
    <ul class="gm-abstract">${abstract("l4")}</ul>
    <p class="gm-label">NVIDIA GB10</p>
    <dl class="gm-specs">${specRows("gb10")}</dl>
    <ul class="gm-abstract">${abstract("gb10")}</ul>
    <p class="gm-source-line" data-gm-source-line>${escapeHtml(sourceLine)}</p>
  `;
}

function applyLanguage() {
  document.documentElement.lang = currentLang;
  document.documentElement.dir = "ltr";

  const isZh = currentLang === "zh";

  const titleCorner = document.querySelector('[data-corner="title"]');
  if (titleCorner) titleCorner.textContent = isZh ? I18n.ZH_UI.plateTitle : "Inside an LLM serving GPU";
  const hintCorner = document.querySelector('[data-corner="hint"]');
  if (hintCorner) hintCorner.textContent = isZh ? I18n.ZH_UI.hint : "click a part · space runs · → steps";

  const eyebrow = $("[data-gm-eyebrow]");
  if (eyebrow) eyebrow.textContent = isZh ? I18n.ZH_UI.eyebrow : "FIG_GPU · An interactive simulation";
  const title = $("[data-gm-title]");
  if (title) title.textContent = isZh ? I18n.ZH_UI.title : "Inside an LLM serving GPU";
  document.title = isZh ? "Inside an LLM Serving GPU · 大模型推理 GPU 深度解析" : "Inside an LLM serving GPU";
  const hook = $("[data-gm-hook]");
  if (hook) {
    hook.innerHTML = isZh
      ? `${escapeHtml(I18n.ZH_UI.hook)} <span class="gm-sub" data-gm-sub>${escapeHtml(I18n.ZH_UI.sub)}</span>`
      : "Decode reads every weight for every token. Watch the bytes leave the memory chips, and see why memory bandwidth sets the pace. <span class=\"gm-sub\" data-gm-sub>L4 or GB10. BF16 or FP8. Fill the pool. Break the cooling.</span>";
  }

  const stepBtn = $("[data-gm-step]");
  if (stepBtn) stepBtn.textContent = isZh ? I18n.ZH_UI.stepBtn : "Step";
  const breakBtn = $("[data-gm-break]");
  if (breakBtn) breakBtn.textContent = isZh ? I18n.ZH_UI.breakBtn : "Break";
  const repairBtn = $("[data-gm-repair]");
  if (repairBtn) repairBtn.textContent = isZh ? I18n.ZH_UI.repairBtn : "Repair";
  const resetBtn = $("[data-gm-reset]");
  if (resetBtn) resetBtn.textContent = isZh ? I18n.ZH_UI.resetBtn : "Reset";
  const copyBtn = $("[data-gm-copy]");
  if (copyBtn) copyBtn.textContent = isZh ? I18n.ZH_UI.copyLinkBtn : "Copy link to this setup";
  const poster = document.querySelector(".gm-poster");
  if (poster) poster.textContent = isZh ? I18n.ZH_UI.downloadPoster : "Download poster";
  const speedLabel = $("[data-gm-speed-label]");
  if (speedLabel) speedLabel.textContent = isZh ? I18n.ZH_UI.speedLabel : "Speed";
  const restart = $("[data-gm-restart]");
  if (restart) restart.textContent = isZh ? I18n.ZH_UI.startOver : "Start over";
  const manualBtn = $("[data-gm-mode=\"manual\"]");
  if (manualBtn) manualBtn.textContent = isZh ? I18n.ZH_UI.manualMode : "Manual";
  const autoBtn = $("[data-gm-mode=\"auto\"]");
  if (autoBtn) autoBtn.textContent = isZh ? I18n.ZH_UI.autoMode : "Auto";

  const switchMap = {
    gpu: "GPU",
    dtype: isZh ? I18n.ZH_UI.weightsLabel : "Weights",
    frac: isZh ? I18n.ZH_UI.fracLabel : "Memory fraction",
    workload: isZh ? I18n.ZH_UI.workloadLabel : "Workload",
    users: isZh ? I18n.ZH_UI.usersLabel : "Users",
    shared: isZh ? I18n.ZH_UI.sharedTokensLabel : "Shared tokens",
    graphs: isZh ? I18n.ZH_UI.cudaGraphsLabel : "CUDA graphs",
    radix: isZh ? I18n.ZH_UI.radixCacheLabel : "Radix cache",
    clock: isZh ? I18n.ZH_UI.hotCardLabel : "Hot card",
  };
  for (const [key, text] of Object.entries(switchMap)) {
    const el = $(`[data-gm-switch="${key}"]`);
    if (el) el.textContent = text;
  }
  const workloadSel = $("#gm-workload");
  if (workloadSel && workloadSel.options.length >= 2) {
    workloadSel.options[0].textContent = isZh ? "独立提示词" : "Unique prompts";
    workloadSel.options[1].textContent = isZh ? "共享系统提示词" : "Shared system prompt";
  }

  for (let i = 0; i < M.STEPS.length; i++) {
    const el = $(`[data-step-name="${i}"]`);
    if (el) el.textContent = isZh ? I18n.ZH_STEPS[i] : M.STEPS[i].name;
  }

  for (let i = 0; i < 11; i++) {
    const btn = $(`[data-scenario-i="${i}"]`);
    const sc = isZh ? I18n.ZH_SCENARIOS[i] : C.SCENARIOS[i];
    if (btn && sc) {
      btn.querySelector("strong").textContent = sc.label;
      btn.querySelector("span").textContent = sc.note;
    }
  }

  const brkTitle = $("[data-gm-break-title]");
  if (brkTitle) brkTitle.textContent = isZh ? I18n.ZH_UI.breakTitle : "Try to break it";
  const brkDesc = $("[data-gm-break-desc]");
  if (brkDesc) brkDesc.textContent = isZh ? I18n.ZH_UI.breakDesc : "Each one sets the switches and runs one request again. Every number comes from a measured run.";
  const wobbleLabel = $("[data-gm-look=\"wobble\"]");
  if (wobbleLabel) wobbleLabel.textContent = isZh ? I18n.ZH_UI.wobbleLabel : "Hand-drawn wobble";
  const boardLabel = $("[data-gm-look=\"board\"]");
  if (boardLabel) boardLabel.textContent = isZh ? I18n.ZH_UI.boardLabel : "Board";
  const labelsLabel = $("[data-gm-look=\"labels\"]");
  if (labelsLabel) labelsLabel.textContent = isZh ? I18n.ZH_UI.labelsLabel : "Labels";

  const idea = $("[data-gm-idea]");
  if (idea) idea.innerHTML = isZh ? I18n.ZH_UI.bigIdea : "<strong>The big idea</strong>Memory, not math, sets the speed of decode, and the KV pool sets how many users fit.";
  const nowLabel = $("[data-gm-now-label]");
  if (nowLabel) nowLabel.textContent = isZh ? I18n.ZH_UI.nowLabel : "Now";

  const roMap = {
    pool: isZh ? I18n.ZH_UI.readouts.pool : "KV pool",
    running: isZh ? I18n.ZH_UI.readouts.running : "Requests",
    tps: isZh ? I18n.ZH_UI.readouts.tps : "Tokens per step",
    share: isZh ? I18n.ZH_UI.readouts.share : "Weight read",
    tpot: isZh ? I18n.ZH_UI.readouts.tpot : "Time per token",
    ttft: isZh ? I18n.ZH_UI.readouts.ttft : "First token",
    toks: isZh ? I18n.ZH_UI.readouts.toks : "Output",
    clock: isZh ? I18n.ZH_UI.readouts.clock : "Clock",
  };
  for (const [key, text] of Object.entries(roMap)) {
    const el = $(`[data-ro-label="${key}"]`);
    if (el) el.textContent = text;
  }

  const tabMap = {
    run: isZh ? I18n.ZH_UI.runTab : "Run",
    memory: isZh ? I18n.ZH_UI.memoryTab : "Memory",
    inspect: isZh ? I18n.ZH_UI.inspectTab : "Inspect",
    trace: isZh ? I18n.ZH_UI.traceTab : "Trace",
    specs: isZh ? I18n.ZH_UI.specsTab : "Specs",
  };
  for (const [key, text] of Object.entries(tabMap)) {
    const el = $(`[data-gm-tab="${key}"]`);
    if (el) el.textContent = text;
  }

  const mLabel = $('[data-run-label="machine"]');
  if (mLabel) mLabel.textContent = isZh ? "机器" : "Machine";
  const wLabel = $('[data-run-label="workload"]');
  if (wLabel) wLabel.textContent = isZh ? "测试负载" : "Workload";
  const oTitle = $('[data-run-outcome-title]');
  if (oTitle) oTitle.textContent = isZh ? "执行结果" : "Outcome";
  const honest = $('[data-gm-honest]');
  if (honest) honest.textContent = isZh ? I18n.ZH_UI.simNote : "This is a simulation. The page does not run a model in your browser. The pool sizes, weight sizes, chunk sizes, step times, first-token times and throughputs are medians of three seeds from the SGLang 101 runs on one NVIDIA L4 and one NVIDIA GB10. The admission count and the weight-read share are arithmetic on those numbers and the published bandwidth. Where a setting was not measured, the page says so. The motion is paced for reading, not to scale.";

  for (const [key, text] of Object.entries(isZh ? I18n.ZH_UI.memoryLegend : { w: "weights", r: "read this step", kv: "pool: other requests", me: "pool: this request", pre: "pool: reused prefix", free: "pool: free" })) {
    const el = $(`[data-legend-key="${key}"]`);
    if (el) el.textContent = text;
  }

  for (const part of C.PART_ORDER) {
    const lbl = document.querySelector(`[data-part-label="${part}"]`);
    if (lbl) {
      lbl.textContent = isZh ? I18n.ZH_NAMES[part] : (typeof C.NAMES[part] === "string" ? C.NAMES[part] : C.NAMES[part].l4.replace("PCIE GEN4 X16", "LINK"));
    }
  }

  const traceIntro = $('[data-gm-trace-intro]');
  if (traceIntro) traceIntro.textContent = isZh ? I18n.ZH_UI.traceIntro : "One line for each step of the request.";

  const whyTitle = $('[data-why="title"]');
  if (whyTitle) whyTitle.textContent = isZh ? I18n.ZH_UI.whatShowsTitle : "What the machine shows";
  const whyP1 = $('[data-why="p1"]');
  if (whyP1) whyP1.innerHTML = isZh ? I18n.ZH_UI.p1 : "<strong>Decode is a memory read.</strong> On the L4, one decode step of Qwen3-8B in BF16 reads 16.41 GB of weights. At the peak 300 GB/s that takes 54.7 ms, and the measured step at one user took 60.16 ms. The SMs wait for the bytes.";
  const whyP2 = $('[data-why="p2"]');
  if (whyP2) whyP2.innerHTML = isZh ? I18n.ZH_UI.p2 : "<strong>Fewer bytes, faster steps.</strong> FP8 weights are 8.81 GB on the L4. The step at one user fell to 39.66 ms, and the freed memory grew the KV pool from 24,094 to 142,369 tokens. At 64 users the output went from 250.85 to 735.91 tok/s.";
  const whyP3 = $('[data-why="p3"]');
  if (whyP3) whyP3.innerHTML = isZh ? I18n.ZH_UI.p3 : "<strong>The pool decides who runs.</strong> The scheduler admits a request only when the pool has room. At 64 users the BF16 pool holds 37 requests and the rest wait. At a memory fraction of 0.74, four 2,048-token prefixes no longer fit, and the median first token took 12.6 s, against 0.47 s at 1,024 shared tokens.";
  const whyP4 = $('[data-why="p4"]');
  if (whyP4) whyP4.innerHTML = isZh ? I18n.ZH_UI.p4 : "<strong>Launch gaps are small.</strong> Without CUDA graphs, each kernel launch crosses from the host. On the L4 that added 0.47 ms to a 60 ms step at one user. Next to the weight read, the launch path barely matters.";
  const whyCtaP = $('[data-why="cta-p"]');
  if (whyCtaP) whyCtaP.textContent = isZh ? I18n.ZH_UI.ctaMeasure : "Measure it on your own GPU.";
  const whyCtaManual = $('[data-why="cta-manual"]');
  if (whyCtaManual) whyCtaManual.textContent = isZh ? I18n.ZH_UI.ctaManual : "Read the SGLang 101 manual";
  const whyCtaQuant = $('[data-why="cta-quant"]');
  if (whyCtaQuant) whyCtaQuant.textContent = isZh ? I18n.ZH_UI.ctaQuant : "Production quantization";

  const gTitle = document.querySelector("[data-gauge] .gauge-title");
  if (gTitle) gTitle.textContent = isZh ? I18n.ZH_UI.gauge.title : "MEMORY READ";
  const cTitle = document.querySelector("[data-cut] .cut-title");
  if (cTitle) cTitle.textContent = isZh ? I18n.ZH_UI.cut.title : "CUT WINDOW · INSIDE THE MEMORY";
  const cCaps = document.querySelectorAll("[data-cut] .cut-cap");
  if (cCaps.length >= 2) {
    cCaps[0].textContent = isZh ? I18n.ZH_UI.cut.weights : "weights";
    cCaps[1].textContent = isZh ? I18n.ZH_UI.cut.kvPool : "KV pool";
  }

  lastPills = "";
  lastCut = "";
  lastGauge = "";
  lastDisplay = "";
  for (const r of Object.values(RIGS)) r._phone = null;

  syncControls();
  syncButtons();
  renderStatic();
  render(state.shown);
  renderSpecs();
  inspect(state.selected);
  draw();
}

function setLanguage(lang) {
  const norm = (lang && String(lang).toLowerCase().startsWith("zh")) ? "zh" : "en";
  if (norm === currentLang) return;
  currentLang = norm;
  applyLanguage();
  writeUrl();
}
window.AIFS_onLangChange = setLanguage;
document.addEventListener("aifs:lang", (e) => setLanguage(e.detail && e.detail.lang));

window.__machine = {
  state,
  load,
  play,
  pause,
  step,
  breakOne,
  repair,
  toggleExplode,
  inspect,
  setLanguage,
  applyLanguage,
  getLanguage: () => currentLang,
  seek: (target) => {
    state.stopAt = target;
    state.playing = true;
    advance(1e6);
    state.playing = false;
    draw();
  },
  advance: (seconds) => {
    state.playing = true;
    advance(seconds);
    state.playing = false;
    draw();
  },
  finish: () => {
    state.playing = true;
    advance(1e6);
    draw();
  },
};
window.__steps = M.stepOf;
window.__configs = M.allConfigs;
window.seek = (t) => {
  load(state.config);
  state.playing = true;
  advance(Math.max(0, Number(t) || 0));
  state.playing = false;
  draw();
  syncSteps();
  return { time: state.time, event: state.shown, total: state.beats.reduce((sum, beat) => sum + beat._dur, 0) };
};
load(state.config);
if (currentLang === "zh") applyLanguage();
let started = false;
if (document.documentElement.hasAttribute("data-poster")) {
  started = true;
  let t = 0;
  for (const beat of state.beats) {
    if (beat.event !== undefined && state.sim.events[beat.event].type === "decode") break;
    t += beat._dur;
  }
  window.seek(t + 0.5);
}
new IntersectionObserver((entries) => {
  const entry = entries[entries.length - 1];
  if (entry.isIntersecting && !started && !still.matches && !renderMode && mode === "auto" && !/[?&]still\b/.test(location.search)) {
    started = true;
    setTimeout(() => state.shown < 0 && !state.playing && play(), 900);
  }
}, { threshold: 0.35 }).observe(stage);
