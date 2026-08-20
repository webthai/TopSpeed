/**
 * Trip Tracker — Google Apps Script backend
 *
 * วิธีติดตั้ง:
 * 1. สร้าง Google Sheet ใหม่ (หรือใช้ที่มีอยู่)
 * 2. เมนู Extensions > Apps Script วางโค้ดนี้ทั้งหมดแทนของเดิม
 * 3. รันฟังก์ชัน setup() หนึ่งครั้ง (เมนู Run > setup) เพื่อสร้างชีต "Trips" และ "TrackPoints"
 *    พร้อมหัวตาราง — ครั้งแรกจะขอสิทธิ์เข้าถึง ให้กด Allow
 * 4. Deploy > New deployment > เลือกประเภท "Web app"
 *      - Execute as: Me
 *      - Who has access: Anyone
 * 5. คัดลอก Web app URL ที่ได้ ไปวางในแอป (ปุ่มตั้งค่ามุมขวาบน)
 */

const TRIPS_SHEET = 'Trips';
const TRACKPOINTS_SHEET = 'TrackPoints';

const TRIPS_HEADERS = [
  'id', 'startTime', 'endTime', 'distanceKm', 'avgSpeedKmh', 'maxSpeedKmh', 'perKmBreakdown', 'syncedAt'
];
const TRACKPOINTS_HEADERS = [
  'id', 'tripId', 'lat', 'lng', 'speedKmh', 'timestamp', 'distanceFromStartKm'
];

// Reading the whole Trips sheet on every ?action=list request is the slowest part of a GET —
// cache the assembled list for a couple of minutes so repeat requests (e.g. several people
// opening the History tab around the same time) don't each re-read the sheet from scratch.
const TRIPS_LIST_CACHE_KEY = 'trips_list_v1';
const TRIPS_LIST_CACHE_TTL_SEC = 120;

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, TRIPS_SHEET, TRIPS_HEADERS);
  ensureSheet_(ss, TRACKPOINTS_SHEET, TRACKPOINTS_HEADERS);
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const trip = body.trip;
    const trackpoints = body.trackpoints || [];

    if (!trip || !trip.id) {
      return jsonResponse_({ ok: false, error: 'missing trip data' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tripsSheet = ensureSheet_(ss, TRIPS_SHEET, TRIPS_HEADERS);
    const pointsSheet = ensureSheet_(ss, TRACKPOINTS_SHEET, TRACKPOINTS_HEADERS);

    upsertTrip_(tripsSheet, trip);

    if (trackpoints.length) {
      const rows = trackpoints.map(p => ([
        p.id, p.tripId, p.lat, p.lng, p.speedKmh, p.timestamp, p.distanceFromStartKm
      ]));
      replaceTrackpointsForTrip_(pointsSheet, trip.id, rows);
    }

    CacheService.getScriptCache().remove(TRIPS_LIST_CACHE_KEY);

    return jsonResponse_({ ok: true, tripId: trip.id, pointsWritten: trackpoints.length });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

function upsertTrip_(sheet, trip) {
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === trip.id) { rowIndex = i + 1; break; }
  }
  const row = [
    trip.id, trip.startTime, trip.endTime, trip.distanceKm,
    trip.avgSpeedKmh, trip.maxSpeedKmh, trip.perKmBreakdown,
    new Date().toISOString()
  ];
  if (rowIndex > 0) {
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  }
}

// Removes any rows already stored for this trip and appends the fresh set — done as ONE read
// and at most ONE clear + ONE write, instead of calling deleteRow per matching row (which is
// very slow for trips with hundreds of points and was the main cause of sync hanging for a while).
function replaceTrackpointsForTrip_(sheet, tripId, newRows) {
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const data = sheet.getRange(2, 1, lastRow - 1, TRACKPOINTS_HEADERS.length).getValues();
    const keep = data.filter(r => r[1] !== tripId);
    sheet.getRange(2, 1, lastRow - 1, TRACKPOINTS_HEADERS.length).clearContent();
    if (keep.length) {
      sheet.getRange(2, 1, keep.length, TRACKPOINTS_HEADERS.length).setValues(keep);
    }
  }
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, newRows.length, TRACKPOINTS_HEADERS.length).setValues(newRows);
}

function doGet(e) {
  const action = e.parameter && e.parameter.action;

  if (action === 'list') {
    return jsonResponse_({ ok: true, trips: getAllTrips_() });
  }

  if (action === 'trip') {
    const id = e.parameter.id;
    if (!id) return jsonResponse_({ ok: false, error: 'missing id' });
    const trip = getAllTrips_().find(t => t.id === id);
    if (!trip) return jsonResponse_({ ok: false, error: 'trip not found' });
    return jsonResponse_({ ok: true, trip: trip, trackpoints: getTrackpointsForTrip_(id) });
  }

  return jsonResponse_({ ok: true, message: 'Trip Tracker backend is running.' });
}

function getAllTrips_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(TRIPS_LIST_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* corrupt cache entry, fall through and rebuild */ }
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TRIPS_SHEET);
  const trips = (!sheet || sheet.getLastRow() < 2) ? [] : sheet
    .getRange(2, 1, sheet.getLastRow() - 1, TRIPS_HEADERS.length)
    .getValues()
    .filter(row => row[0]) // skip any blank rows
    .map(row => ({
      id: row[0], startTime: row[1], endTime: row[2], distanceKm: row[3],
      avgSpeedKmh: row[4], maxSpeedKmh: row[5], perKmBreakdown: row[6], syncedAt: row[7]
    }));

  try {
    cache.put(TRIPS_LIST_CACHE_KEY, JSON.stringify(trips), TRIPS_LIST_CACHE_TTL_SEC);
  } catch (e) {
    // Cache values over 100KB are rejected by CacheService — fine, we just skip caching
    // this time and every ?action=list request reads the sheet directly instead.
  }

  return trips;
}

function getTrackpointsForTrip_(tripId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TRACKPOINTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, TRACKPOINTS_HEADERS.length).getValues();
  return data
    .filter(row => row[1] === tripId)
    .map(row => ({
      id: row[0], tripId: row[1], lat: row[2], lng: row[3],
      speedKmh: row[4], timestamp: row[5], distanceFromStartKm: row[6]
    }));
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
