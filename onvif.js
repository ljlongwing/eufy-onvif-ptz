// Minimal ONVIF PTZ front for eufy pan/tilt cameras: Frigate talks ONVIF to this, moves are forwarded to eufy-security-ws.
// One HTTP port per camera (Frigate's onvif config only has host + port). No auth: keep it on the docker network only.
const http = require('http');
const WebSocket = require('ws');

const EUFY_WS = process.env.EUFY_WS || 'ws://eufy-security-ws:3000';
// CAMS="8001=SERIAL:Name,8002=SERIAL:Name"
const CAMS = (process.env.CAMS || '').split(',').filter(Boolean).map((s) => {
  const [port, rest = ''] = s.split('=');
  const [serial, name = serial] = rest.split(':');
  if (!Number(port) || !serial) throw new Error(`bad CAMS entry "${s}", expected PORT=SERIAL[:name]`);
  return { port: Number(port), serial, name, timer: null, steps: 0 };
});
if (!CAMS.length) throw new Error('CAMS is empty, expected e.g. CAMS=8001=T8W11P0000000000:living_room');
const STEP_MS = Number(process.env.STEP_MS || 700);      // repeat interval while a move button is held
const MAX_STEPS = Number(process.env.MAX_STEPS || 15);   // safety cap if the Stop never arrives
const PRESETS = Number(process.env.PRESETS || 4);
const DIR = { left: 1, right: 2, up: 3, down: 4 };

const log = (...a) => console.log(new Date().toLocaleString('sv'), ...a);

// ---- eufy-security-ws client -------------------------------------------------
let ws = null, ready = false, msgId = 0;
function connect() {
  ws = new WebSocket(EUFY_WS);
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'version') {
      ws.send(JSON.stringify({ messageId: 'schema', command: 'set_api_schema', schemaVersion: msg.maxSchemaVersion }));
      ws.send(JSON.stringify({ messageId: 'listen', command: 'start_listening' }));
    } else if (msg.type === 'result') {
      if (msg.messageId === 'listen') { ready = msg.success; log('eufy-security-ws', ready ? 'connected' : 'start_listening failed'); }
      else if (!msg.success) log('command failed', msg.messageId, msg.errorCode);
    } else if (msg.type === 'event' && msg.event?.event === 'command result' && msg.event.returnCode !== 0) {
      log('camera rejected', msg.event.command, msg.event.serialNumber, msg.event.returnCodeName);
    }
  });
  ws.on('close', () => { ready = false; log('eufy-security-ws disconnected, retrying'); setTimeout(connect, 5000); });
  ws.on('error', (e) => log('eufy-security-ws error', e.message));
}
function eufy(command, extra) {
  if (!ready) { log('not connected, dropped', command); return; }
  ws.send(JSON.stringify({ messageId: command + '-' + (++msgId), command, ...extra }));
}

// ---- PTZ actions -------------------------------------------------------------
function stop(cam) { if (cam.timer) { clearInterval(cam.timer); cam.timer = null; } }
function move(cam, dir) {
  stop(cam);
  cam.steps = 0;
  const step = () => {
    if (++cam.steps > MAX_STEPS) return stop(cam);
    eufy('device.pan_and_tilt', { serialNumber: cam.serial, direction: DIR[dir] });
  };
  log(cam.name, 'move', dir);
  step();
  cam.timer = setInterval(step, STEP_MS);
}
function preset(cam, n) {
  stop(cam);
  log(cam.name, 'go to preset', n + 1);
  eufy('device.preset_position', { serialNumber: cam.serial, position: n });
}

// ---- SOAP --------------------------------------------------------------------
const NS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:ter="http://www.onvif.org/ver10/error"';
const envelope = (body) => `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}><s:Body>${body}</s:Body></s:Envelope>`;
const fault = (op) => envelope(`<s:Fault><s:Code><s:Value>s:Receiver</s:Value><s:Subcode><s:Value>ter:ActionNotSupported</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">${op} not supported</s:Text></s:Reason></s:Fault>`);
const VEL = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace';

function handle(cam, op, xml, base) {
  switch (op) {
    case 'GetSystemDateAndTime': {
      const d = new Date();
      return `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:TimeZone><tt:TZ>UTC0</tt:TZ></tt:TimeZone><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`;
    }
    case 'GetCapabilities':
      return `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>${base}/onvif/device_service</tt:XAddr></tt:Device><tt:Media><tt:XAddr>${base}/onvif/media_service</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>false</tt:RTPMulticast><tt:RTP_TCP>true</tt:RTP_TCP><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP></tt:StreamingCapabilities></tt:Media><tt:PTZ><tt:XAddr>${base}/onvif/ptz_service</tt:XAddr></tt:PTZ></tds:Capabilities></tds:GetCapabilitiesResponse>`;
    case 'GetServices':
      return `<tds:GetServicesResponse>` + [['http://www.onvif.org/ver10/device/wsdl', 'device_service', 1], ['http://www.onvif.org/ver10/media/wsdl', 'media_service', 1], ['http://www.onvif.org/ver20/ptz/wsdl', 'ptz_service', 2]]
        .map(([ns, p, maj]) => `<tds:Service><tds:Namespace>${ns}</tds:Namespace><tds:XAddr>${base}/onvif/${p}</tds:XAddr><tds:Version><tt:Major>${maj}</tt:Major><tt:Minor>0</tt:Minor></tds:Version></tds:Service>`).join('') + `</tds:GetServicesResponse>`;
    case 'GetDeviceInformation':
      return `<tds:GetDeviceInformationResponse><tds:Manufacturer>eufy</tds:Manufacturer><tds:Model>eufy-onvif shim</tds:Model><tds:FirmwareVersion>1</tds:FirmwareVersion><tds:SerialNumber>${cam.serial}</tds:SerialNumber><tds:HardwareId>${cam.serial}</tds:HardwareId></tds:GetDeviceInformationResponse>`;
    case 'GetProfiles':
      return `<trt:GetProfilesResponse><trt:Profiles token="main" fixed="true"><tt:Name>main</tt:Name>` +
        `<tt:VideoEncoderConfiguration token="venc"><tt:Name>venc</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution><tt:Quality>5</tt:Quality><tt:Multicast><tt:Address><tt:Type>IPv4</tt:Type><tt:IPv4Address>0.0.0.0</tt:IPv4Address></tt:Address><tt:Port>0</tt:Port><tt:TTL>1</tt:TTL><tt:AutoStart>false</tt:AutoStart></tt:Multicast><tt:SessionTimeout>PT60S</tt:SessionTimeout></tt:VideoEncoderConfiguration>` +
        `<tt:PTZConfiguration token="ptz"><tt:Name>ptz</tt:Name><tt:UseCount>1</tt:UseCount><tt:NodeToken>node</tt:NodeToken><tt:DefaultContinuousPanTiltVelocitySpace>${VEL}</tt:DefaultContinuousPanTiltVelocitySpace><tt:DefaultPTZTimeout>PT10S</tt:DefaultPTZTimeout></tt:PTZConfiguration>` +
        `</trt:Profiles></trt:GetProfilesResponse>`;
    case 'GetConfigurationOptions':
      return `<tptz:GetConfigurationOptionsResponse><tptz:PTZConfigurationOptions><tt:Spaces><tt:ContinuousPanTiltVelocitySpace><tt:URI>${VEL}</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:ContinuousPanTiltVelocitySpace></tt:Spaces><tt:PTZTimeout><tt:Min>PT1S</tt:Min><tt:Max>PT60S</tt:Max></tt:PTZTimeout></tptz:PTZConfigurationOptions></tptz:GetConfigurationOptionsResponse>`;
    case 'GetPresets':
      return `<tptz:GetPresetsResponse>` + Array.from({ length: PRESETS }, (_, i) => `<tptz:Preset token="${i}"><tt:Name>Preset ${i + 1}</tt:Name></tptz:Preset>`).join('') + `</tptz:GetPresetsResponse>`;
    case 'ContinuousMove': {
      const m = xml.match(/PanTilt\b[^>]*>/);
      const x = Number(m?.[0].match(/\bx="([^"]+)"/)?.[1] || 0), y = Number(m?.[0].match(/\by="([^"]+)"/)?.[1] || 0);
      const dir = Math.abs(x) >= Math.abs(y) ? (x < 0 ? 'left' : x > 0 ? 'right' : null) : (y > 0 ? 'up' : 'down');
      if (dir) move(cam, dir);
      return `<tptz:ContinuousMoveResponse/>`;
    }
    case 'Stop':
      stop(cam);
      return `<tptz:StopResponse/>`;
    case 'GotoPreset': {
      const n = Number(xml.match(/PresetToken[^>]*>\s*(\d+)\s*</)?.[1]);
      if (n >= 0 && n < PRESETS) preset(cam, n);
      return `<tptz:GotoPresetResponse/>`;
    }
    default:
      return null;
  }
}

for (const cam of CAMS) {
  http.createServer((req, res) => {
    let xml = '';
    req.on('data', (c) => { xml += c; });
    req.on('end', () => {
      const op = xml.match(/<(?:[\w-]+:)?Body[^>]*>\s*<(?:[\w-]+:)?([\w]+)/)?.[1] || '?';
      const out = handle(cam, op, xml, `http://${req.headers.host}`);
      if (out === null) log(cam.name, 'unsupported request', op);
      res.writeHead(out === null ? 500 : 200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
      res.end(out === null ? fault(op) : envelope(out));
    });
  }).listen(cam.port, () => log(cam.name, cam.serial, 'ONVIF on port', cam.port));
}
connect();
