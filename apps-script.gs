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
  return jsonResponse_({ ok: true, message: 'Trip Tracker backend is running.' });
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
