const API_KEY = "AIzaSyDsVXzfEamsmukzhgdBtByA2IsbDinlgXQ";

let map = null;
let Place = null;
let AdvancedMarkerElement = null;
let markers = [];
let searchTimer = null;
let searchSeq = 0;
let lastSearchSignature = "";

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
    script.onload = resolve;
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
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchArea, 500);
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

  // Nearby Search has a maximum radius of 50 km. We split the viewport
  // into small cells so a wide map does not silently search only its center.
  const maxCellDegrees = 0.62;
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
  return { centers, rows, cols };
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
    const results = await Promise.allSettled(plan.centers.map((center) => searchCell(center)));
    if (seq !== searchSeq) return;

    const all = [];
    let failures = 0;
    for (const result of results) {
      if (result.status === "fulfilled") all.push(...result.value);
      else failures++;
    }

    const unique = dedupePlaces(all).filter(isActualLpg);
    const visible = unique.filter((p) => isInsideViewport(p, bounds));
    draw(visible);

    if (failures === results.length) {
      $("count").textContent = "ค้นหาไม่สำเร็จ";
      status("Google Places ไม่ตอบข้อมูล กรุณาตรวจ API Key หรือโควตา", 5000);
    } else {
      $("count").textContent = `LPG ในพื้นที่นี้ ${visible.length} แห่ง`;
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

async function searchCell(center) {
  const { places } = await Place.searchNearby({
    fields: [
      "id",
      "displayName",
      "location",
      "formattedAddress",
      "googleMapsURI",
      "primaryType",
      "types",
      "fuelOptions"
    ],
    locationRestriction: {
      center,
      radius: 50000
    },
    includedPrimaryTypes: ["gas_station"],
    maxResultCount: 20,
    rankPreference: "DISTANCE"
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

function hasStrongLpgName(place) {
  const text = [
    place.displayName?.text || place.displayName || "",
    place.formattedAddress || ""
  ].join(" ").toLowerCase();
  return /\blpg\b|แก๊ส lpg|ก๊าซ lpg|ปั๊ม lpg|lpg station/.test(text);
}

function isActualLpg(place) {
  // Prefer Google's structured fuel data. If Google has not supplied it,
  // accept only a strong LPG name signal rather than every generic gas station.
  return hasLpgFuelData(place) || hasStrongLpgName(place);
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

    const el = document.createElement("div");
    el.className = "lpg-pin";
    el.textContent = "LPG";

    const marker = new AdvancedMarkerElement({
      map,
      position: place.location,
      content: el,
      title: place.displayName?.text || place.displayName || "สถานี LPG",
      gmpClickable: true
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
  const name = esc(place.displayName?.text || place.displayName || "สถานี LPG");
  const address = esc(place.formattedAddress || "ไม่มีข้อมูลที่อยู่");
  const mapsUrl = place.googleMapsURI || `https://www.google.com/maps/search/?api=1&query=${place.location.lat()},${place.location.lng()}`;

  const lpg = getFuelPrices(place).find((fuel) => String(fuel.type || "").toUpperCase() === "LPG");
  let priceHtml = `<div class="meta"><b>ราคา LPG:</b> ไม่มีข้อมูลราคา</div>`;
  if (lpg?.price) {
    const price = formatPrice(lpg);
    const updated = formatUpdateTime(lpg.updateTime);
    priceHtml = `<div class="meta"><b>ราคา LPG:</b> ${esc(price || "มีข้อมูลราคา")}</div>` +
      (updated ? `<div class="updated">อัปเดต/ตรวจพบ: ${esc(updated)}</div>` : "");
  }

  const verification = hasLpgFuelData(place)
    ? "Google Places มีข้อมูลเชื้อเพลิง LPG ของสถานีนี้"
    : "ชื่อสถานีระบุ LPG แต่ Google ยังไม่มีข้อมูลเชื้อเพลิงแบบโครงสร้าง";

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
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchText(input.value.trim()), 450);
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
