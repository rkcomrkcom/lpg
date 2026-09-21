const KEY = "lpgFinderApiKey";

let map = null;
let Place = null;
let AdvancedMarkerElement = null;
let markers = [];
let mapTimer = null;   // ตัวจับเวลาสำหรับค้นหาตามแมพ
let textTimer = null;  // ตัวจับเวลาสำหรับช่องค้นหาข้อความ
let searchSeq = 0;
let lastSearchSignature = "";
let authFailed = false;
let loadedKey = null;

const PLACE_FIELDS = [
  "id",
  "displayName",
  "location",
  "formattedAddress",
  "googleMapsURI",
  "primaryType",
  "types",
  "fuelOptions"
];

const $ = (id) => document.getElementById(id);

function status(message, ms = 3000) {
  $("status").textContent = message;
  $("status").hidden = false;
  clearTimeout(status.timer);
  if (ms > 0) status.timer = setTimeout(() => { $("status").hidden = true; }, ms);
}

function showFatal(message) {
  $("keyError").textContent = message;
  $("keyError").hidden = false;
  $("keyScreen").hidden = false;
}

function clearFatal() {
  $("keyError").hidden = true;
  $("keyError").textContent = "";
}

window.gm_authFailure = () => {
  authFailed = true;
  showFatal("Google Maps ปฏิเสธ API Key นี้ หรือคีย์หมดโควตา Demo แล้ว");
};

async function loadMaps(key) {
  if (window.google?.maps) return;

  await new Promise((resolve, reject) => {
    const old = document.querySelector('script[data-lpg-google="1"]');
    if (old) old.remove();

    const script = document.createElement("script");
    script.dataset.lpgGoogle = "1";
    script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&v=weekly&libraries=places,marker";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      loadedKey = key;
      resolve();
    };
    script.onerror = () => reject(new Error("โหลด Google Maps ไม่สำเร็จ กรุณาตรวจ API Key"));
    document.head.appendChild(script);
  });
}

async function start() {
  clearFatal();
  const key = localStorage.getItem(KEY);
  if (!key) {
    $("keyScreen").hidden = false;
    return;
  }

  try {
    status("กำลังโหลด Google Maps…", 8000);
    await loadMaps(key);
    await init();
    if (authFailed) return; // ให้หน้ากรอกคีย์และข้อความ error ค้างอยู่
    $("keyScreen").hidden = true;
    status("พร้อมใช้งาน", 1500);
  } catch (error) {
    console.error(error);
    showFatal(error?.message || "เปิด Google Maps ไม่สำเร็จ");
  }
}

async function init() {
  const mapsLib = await google.maps.importLibrary("maps");
  const placesLib = await google.maps.importLibrary("places");
  const markerLib = await google.maps.importLibrary("marker");

  Place = placesLib.Place;
  AdvancedMarkerElement = markerLib.AdvancedMarkerElement;

  if (!Place || !AdvancedMarkerElement) {
    throw new Error("เบราว์เซอร์โหลด Places หรือ Marker library ไม่สำเร็จ");
  }

  map = new mapsLib.Map($("map"), {
    center: { lat: 17.4048, lng: 104.7860 },
    zoom: 10,
    mapId: "DEMO_MAP_ID",
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: "greedy"
  });

  map.addListener("idle", () => {
    clearTimeout(mapTimer);
    mapTimer = setTimeout(searchArea, 500);
  });

  $("refresh").onclick = () => searchArea(true);
  $("locate").onclick = locate;
  $("close").onclick = () => $("panel").hidden = true;
  $("resetKey").onclick = resetKey;

  setupSearch();

  await new Promise((resolve) => google.maps.event.addListenerOnce(map, "idle", resolve));
  await searchArea(true);
}

function viewportSignature() {
  if (!map || !map.getBounds()) return "";
  const b = map.getBounds();
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();
  return [sw.lat().toFixed(4), sw.lng().toFixed(4), ne.lat().toFixed(4), ne.lng().toFixed(4), map.getZoom()].join("|");
}

function buildSearchCenters(bounds) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const latSpan = Math.abs(ne.lat() - sw.lat());
  const lngSpan = Math.abs(ne.lng() - sw.lng());

  // Nearby Search returns at most 20 places per request, so we split the
  // viewport into small cells. Smaller cells = more stations found overall.
  const maxCellDegrees = 0.35;
  const rows = Math.max(1, Math.min(4, Math.ceil(latSpan / maxCellDegrees)));
  const cols = Math.max(1, Math.min(4, Math.ceil(lngSpan / maxCellDegrees)));

  const centers = [];
  for (let r = 0; r < rows; r++) {
    const lat = sw.lat() + latSpan * (r + 0.5) / rows;
    for (let c = 0; c < cols; c++) {
      const lng = sw.lng() + lngSpan * (c + 0.5) / cols;
      centers.push({ lat, lng });
    }
  }

  // รัศมีของแต่ละเซลล์ (ครึ่งเส้นทแยงมุม) เพื่อให้ผลลัพธ์อยู่ในเซลล์นั้นจริง ๆ
  // ไม่ใช่ 20 ปั๊มที่ใกล้จุดกลางที่สุดในรัศมี 50 กม.
  const midLat = (sw.lat() + ne.lat()) / 2;
  const halfLatM = (latSpan / rows / 2) * 111320;
  const halfLngM = (lngSpan / cols / 2) * 111320 * Math.cos(midLat * Math.PI / 180);
  const radius = Math.min(50000, Math.max(1000, Math.round(Math.hypot(halfLatM, halfLngM))));

  return { centers, rows, cols, radius };
}

async function searchArea(force = false) {
  if (!map || !map.getBounds()) return;

  const signature = viewportSignature();
  if (!force && signature === lastSearchSignature) return;
  lastSearchSignature = signature;

  const zoom = map.getZoom() || 0;
  if (zoom < 8) {
    clearMarkers();
    $("count").textContent = "ซูมเข้าอีกนิดเพื่อค้นหา LPG";
    status("ซูมเข้าเพื่อให้ค้นหาสถานี LPG ได้ละเอียดขึ้น", 3000);
    return;
  }

  const seq = ++searchSeq;
  const bounds = map.getBounds();
  const plan = buildSearchCenters(bounds);
  $("count").textContent = "กำลังค้นหา LPG…";
  $("refresh").disabled = true;

  try {
    // ค้นหาปั๊มทุกชนิดรอบจุดต่าง ๆ + ค้นหาด้วยข้อความ "LPG / ปั๊มแก๊ส" ทั้งพื้นที่ที่เห็น
    // (ผลจากการค้นหาแบบ Nearby มาก่อน เพื่อให้ dedupe เก็บตัวที่มีข้อมูลเชื้อเพลิงไว้)
    const tasks = [
      ...plan.centers.map((center) => searchCell(center, plan.radius)),
      searchViewportText(bounds)
    ];
    const results = await Promise.allSettled(tasks);
    if (seq !== searchSeq) return;

    const all = [];
    let failures = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        all.push(...result.value);
      } else {
        failures++;
        console.error("Places search failed:", result.reason);
      }
    }

    const unique = dedupePlaces(all).filter(isShownPlace);
    const visible = unique.filter((p) => isInsideViewport(p, bounds));
    draw(visible);

    const lpgCount = visible.filter(isActualLpg).length;
    const fuelCount = visible.length - lpgCount;

    if (failures === results.length) {
      $("count").textContent = "ค้นหาไม่สำเร็จ";
      status("Google Places ไม่ตอบข้อมูล กรุณาตรวจ API Key หรือโควตา (ดู error ใน Console)", 5000);
    } else {
      $("count").textContent = `🔴 LPG ${lpgCount} · 🔵 ปั๊มน้ำมัน ${fuelCount}`;
      if (failures) status(`ค้นหาได้บางส่วน (${failures} จุดค้นหามีปัญหา)`, 3500);
    }
  } catch (error) {
    console.error(error);
    $("count").textContent = "ค้นหาไม่สำเร็จ";
    status(error?.message || "Google Places ค้นหาไม่สำเร็จ", 5000);
  } finally {
    if (seq === searchSeq) $("refresh").disabled = false;
  }
}

async function searchCell(center, radius) {
  const { places } = await Place.searchNearby({
    fields: PLACE_FIELDS,
    locationRestriction: {
      center,
      radius
    },
    includedPrimaryTypes: ["gas_station"],
    maxResultCount: 20,
    rankPreference: "DISTANCE",
    language: "th",
    region: "TH"
  });
  return places || [];
}

async function searchViewportText(bounds) {
  const { places } = await Place.searchByText({
    textQuery: "ปั๊มแก๊ส LPG",
    fields: PLACE_FIELDS,
    locationRestriction: bounds,
    maxResultCount: 20,
    language: "th",
    region: "TH"
  });
  return places || [];
}

function dedupePlaces(places) {
  const seen = new Map();
  for (const p of places) {
    const key = p.id || `${p.location?.lat?.()}:${p.location?.lng?.()}:${p.displayName?.text || p.displayName || ""}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()];
}

function getFuelPrices(place) {
  return place?.fuelOptions?.fuelPrices || [];
}

function hasLpgFuelData(place) {
  return getFuelPrices(place).some((fuel) => String(fuel.type || "").toUpperCase() === "LPG");
}

function normalizeThai(text) {
  // ตัดไม้ไต่คู้และวรรณยุกต์ออก เพื่อให้จับได้ทุกแบบที่คนสะกด เช่น แก๊ส แก็ส แก๊ซ ก๊าซ
  return String(text || "").toLowerCase().replace(/[\u0E47-\u0E4B]/g, "");
}

function hasStrongLpgName(place) {
  const name = normalizeThai(place.displayName?.text || place.displayName);
  const address = normalizeThai(place.formattedAddress);

  // เจอคำว่า LPG / แอลพีจี ที่ชื่อหรือที่อยู่
  if (/lpg|แอลพีจี/.test(name + " " + address)) return true;

  // ชื่อมีคำว่า แก๊ส / แก็ส / แก๊ซ / ก๊าซ แต่ไม่ใช่ NGV/CNG
  if (/แก[สซ]|กาซ/.test(name) && !/ngv|cng|เอ็นจีวี/.test(name)) return true;

  return false;
}

function isActualLpg(place) {
  // Prefer Google's structured fuel data. If Google has not supplied it,
  // accept a strong LPG/แก๊ส name signal.
  return hasLpgFuelData(place) || hasStrongLpgName(place);
}

function isGasStation(place) {
  return place.primaryType === "gas_station" || (place.types || []).includes("gas_station");
}

function isShownPlace(place) {
  // แสดงทั้งปั๊ม LPG (หมุดแดง) และปั๊มน้ำมันทั่วไป (หมุดฟ้า)
  return isActualLpg(place) || isGasStation(place);
}

function isInsideViewport(place, bounds) {
  if (!place.location) return false;
  return bounds.contains(place.location);
}

function clearMarkers() {
  for (const marker of markers) marker.map = null;
  markers = [];
}

function draw(places) {
  clearMarkers();
  for (const place of places) {
    if (!place.location) continue;

    const isLpg = isActualLpg(place);

    const el = document.createElement("div");
    el.className = "pin " + (isLpg ? "pin-lpg" : "pin-fuel");
    el.textContent = isLpg ? "LPG" : "⛽";

    const marker = new AdvancedMarkerElement({
      map,
      position: place.location,
      content: el,
      title: place.displayName?.text || place.displayName || (isLpg ? "สถานี LPG" : "ปั๊มน้ำมัน"),
      gmpClickable: true,
      zIndex: isLpg ? 2 : 1 // หมุด LPG อยู่บนสุดเมื่อซ้อนกัน
    });

    marker.addListener("click", () => openStation(place));
    markers.push(marker);
  }
}

function formatPrice(fuel) {
  const units = Number(fuel?.price?.units || 0);
  const nanos = Number(fuel?.price?.nanos || 0);
  const value = units + nanos / 1e9;
  if (!Number.isFinite(value)) return null;
  return `${value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 3 })} ${fuel.price.currencyCode || ""}`.trim();
}

function formatUpdateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok"
  }).format(d);
}

function openStation(place) {
  const isLpg = isActualLpg(place);
  const name = esc(place.displayName?.text || place.displayName || (isLpg ? "สถานี LPG" : "ปั๊มน้ำมัน"));
  const address = esc(place.formattedAddress || "ไม่มีข้อมูลที่อยู่");
  const mapsUrl = place.googleMapsURI || `https://www.google.com/maps/search/?api=1&query=${place.location.lat()},${place.location.lng()}`;

  let priceHtml = "";
  let verification;

  if (isLpg) {
    const lpg = getFuelPrices(place).find((fuel) => String(fuel.type || "").toUpperCase() === "LPG");
    priceHtml = `<div class="meta"><b>ราคา LPG:</b> ไม่มีข้อมูลราคา</div>`;
    if (lpg?.price) {
      const price = formatPrice(lpg);
      const updated = formatUpdateTime(lpg.updateTime);
      priceHtml = `<div class="meta"><b>ราคา LPG:</b> ${esc(price || "มีข้อมูลราคา")}</div>` +
        (updated ? `<div class="updated">อัปเดต/ตรวจพบ: ${esc(updated)}</div>` : "");
    }

    verification = hasLpgFuelData(place)
      ? "Google Places มีข้อมูลเชื้อเพลิง LPG ของสถานีนี้"
      : "ชื่อสถานีระบุ LPG/แก๊ส แต่ Google ยังไม่มีข้อมูลเชื้อเพลิงแบบโครงสร้าง";
  } else {
    verification = "ปั๊มน้ำมันทั่วไป (ไม่พบข้อมูลว่ามี LPG)";
  }

  $("panelContent").innerHTML = `
    <div class="title">${name}</div>
    <div class="address">${address}</div>
    <div class="meta">⛽ ${esc(verification)}</div>
    ${priceHtml}
    <div class="actions"><a href="${esc(mapsUrl)}" target="_blank" rel="noopener">เปิด Google Maps / นำทาง</a></div>
  `;
  $("panel").hidden = false;
}

function locate() {
  if (!navigator.geolocation) return status("เบราว์เซอร์นี้ไม่รองรับ GPS", 4000);

  status("กำลังหาตำแหน่ง…", 5000);
  navigator.geolocation.getCurrentPosition(
    (position) => {
      map.setCenter({ lat: position.coords.latitude, lng: position.coords.longitude });
      map.setZoom(13);
      status("เลื่อนไปตำแหน่งปัจจุบันแล้ว", 1800);
    },
    (error) => {
      const msg = error.code === 1 ? "กรุณาอนุญาต Location ให้เว็บนี้" : "หาตำแหน่ง GPS ไม่สำเร็จ";
      status(msg, 4500);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

function setupSearch() {
  const input = $("search");
  const clear = $("clear");
  const results = $("results");

  input.oninput = () => {
    clear.hidden = !input.value.trim();
    clearTimeout(textTimer);
    textTimer = setTimeout(() => searchText(input.value.trim()), 450);
  };

  clear.onclick = () => {
    input.value = "";
    clear.hidden = true;
    results.hidden = true;
    input.focus();
  };
}

async function searchText(query) {
  const results = $("results");
  if (!query) {
    results.hidden = true;
    return;
  }

  try {
    const { places } = await Place.searchByText({
      textQuery: query,
      fields: ["id", "displayName", "formattedAddress", "location", "googleMapsURI"],
      maxResultCount: 5,
      language: "th",
      region: "TH"
    });

    results.innerHTML = "";
    for (const place of places || []) {
      const button = document.createElement("button");
      button.className = "result";
      button.innerHTML = `<b>${esc(place.displayName?.text || place.displayName || "")}</b><small>${esc(place.formattedAddress || "")}</small>`;
      button.onclick = () => {
        if (place.location) {
          map.setCenter(place.location);
          map.setZoom(12);
        }
        results.hidden = true;
      };
      results.appendChild(button);
    }
    results.hidden = !(places || []).length;
  } catch (error) {
    console.error(error);
    results.hidden = true;
    status("ค้นหาสถานที่ไม่สำเร็จ", 3500);
  }
}

function resetKey() {
  localStorage.removeItem(KEY);
  location.reload();
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

$("start").onclick = async () => {
  const key = $("apiKey").value.trim();
  if (!key) return status("กรุณาใส่ Maps Demo Key", 3500);
  localStorage.setItem(KEY, key);

  // ถ้าเคยโหลด Google Maps ด้วยคีย์เดิม/คีย์ที่ถูกปฏิเสธไปแล้ว ต้องรีโหลดหน้าเพื่อใช้คีย์ใหม่
  if (window.google?.maps && (authFailed || loadedKey !== key)) {
    location.reload();
    return;
  }

  $("start").disabled = true;
  try {
    await start();
  } finally {
    $("start").disabled = false;
  }
};

$("apiKey").onkeydown = (event) => {
  if (event.key === "Enter") $("start").click();
};

start();
