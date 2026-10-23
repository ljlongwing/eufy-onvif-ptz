# eufy-onvif-ptz

Pan/tilt control for **eufy** cameras in **Frigate** (and anything else that speaks ONVIF PTZ).

eufy pan/tilt cameras don't speak ONVIF, and Frigate's PTZ controls only work over ONVIF. This
small container pretends to be an ONVIF camera with PTZ support and forwards each move to
[eufy-security-ws](https://github.com/bropat/eufy-security-ws), which talks to the camera the
same way the eufy app does.

```
Frigate (ONVIF PTZ)  ──►  eufy-onvif-ptz  ──►  eufy-security-ws  ──►  eufy camera / HomeBase
```

Video still comes from wherever you already get it (HomeBase RTSP, go2rtc, ...). This only handles
movement.

## What works

- **Arrow buttons in Frigate's live view** (ContinuousMove / Stop). eufy only moves in fixed steps
  (roughly 11% of the frame width), so holding a button repeats a step every `STEP_MS` until you
  let go, capped at `MAX_STEPS`.
- **Home Assistant**, through the Frigate integration's `frigate.ptz` action.
- **Presets** show up as "Preset 1..4" and map to eufy's 4 preset slots (`device.preset_position`).
  Untested: they only do something if you saved positions in the eufy app.
- No zoom, no speed control, no absolute positioning. eufy doesn't offer them.

## Setup

You need a running eufy-security-ws that can already see your cameras.

Each camera gets its own port, because Frigate's `onvif` config only takes a host and a port:

```yaml
# docker-compose.yml
services:
  eufy-onvif-ptz:
    build: .
    container_name: eufy-onvif-ptz
    restart: unless-stopped
    environment:
      EUFY_WS: ws://eufy-security-ws:3000        # your eufy-security-ws address
      CAMS: 8001=T8W11P0000000000:living_room,8002=T8W11P1111111111:kitchen   # PORT=SERIAL[:name]
      # STEP_MS: 700     # repeat interval while a button is held
      # MAX_STEPS: 15    # safety cap if Stop never arrives
      # PRESETS: 4
    # No published ports: put it on the same docker network as Frigate instead.
    networks: [frigate]
networks:
  frigate:
    external: true
    name: frigate_default   # Frigate's network name in your setup
```

Find the serial numbers in the eufy app (Device settings → General → About device) or in eufy-security-ws.

Then point each Frigate camera at its port:

```yaml
cameras:
  living_room:
    onvif:
      host: eufy-onvif-ptz
      port: 8001
      user: admin        # required by Frigate, ignored by the shim
      password: unused
```

Restart Frigate. The camera's live view should now show the PTZ arrows.

### Home Assistant

The Frigate integration exposes `frigate.ptz`. A short "move then stop" gives you one step:

```yaml
script:
  camera_ptz_step:
    fields:
      camera: {example: camera.living_room}
      direction: {example: left}
    sequence:
      - action: frigate.ptz
        target: {entity_id: "{{ camera }}"}
        data: {action: move, argument: "{{ direction }}"}
      - delay: {milliseconds: 200}
      - action: frigate.ptz
        target: {entity_id: "{{ camera }}"}
        data: {action: stop}
```

## Security

The shim has **no authentication**: anything that can reach its ports can move your cameras.
Don't publish the ports. Keep it on the docker network Frigate uses.

## Troubleshooting

- `docker logs eufy-onvif-ptz` shows each move, preset and any request it doesn't support.
  "camera rejected" means eufy-security-ws accepted the command but the camera refused it.
- `tools/probe.py` drives the shim through the same Python ONVIF library Frigate uses. Run it
  inside the Frigate container:
  `docker cp tools/probe.py frigate:/tmp/ && docker exec frigate python3 /tmp/probe.py eufy-onvif-ptz 8001 left`
- Moving a camera looks like motion to Frigate, and it shifts any zones or masks you've drawn.

## Tested with

Frigate 0.18.2, eufy-security-ws 3.1.0 (eufy-security-client 4.1.0, API schema 21), two eufy
`T8W11C` indoor pan/tilt cameras (firmware 4.0.9.4) on a HomeBase.

Other eufy pan/tilt models that support `device.pan_and_tilt` in eufy-security-ws should work too.
Reports welcome.

Heads-up: eufy-security-client describes itself as a stopgap while eufy moves to a new platform,
so upstream changes may break this.

## Notes

Built with help from Claude (Anthropic) and tested on my own setup.

## License

MIT
