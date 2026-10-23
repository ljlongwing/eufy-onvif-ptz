# Exercises the shim with the same ONVIF library Frigate uses. Run inside the Frigate container:
#   docker cp tools/probe.py frigate:/tmp/ && docker exec frigate python3 /tmp/probe.py eufy-onvif 8001 left
import asyncio, sys
from importlib.util import find_spec
from pathlib import Path
from onvif import ONVIFCamera

async def main(host, port, action):
    cam = ONVIFCamera(host, int(port), "admin", "x", wsdl_dir=str(Path(find_spec("onvif").origin).parent / "wsdl"))
    await cam.update_xaddrs()
    media = await cam.create_media_service()
    print("ptz def", cam.get_definition("ptz"))
    profiles = await media.GetProfiles()
    p = profiles[0]
    print("profile", p.token, bool(p.VideoEncoderConfiguration), p.PTZConfiguration.DefaultContinuousPanTiltVelocitySpace)
    ptz = await cam.create_ptz_service()
    try:
        await cam.create_imaging_service()
        print("imaging: created")
    except Exception as e:
        print("imaging:", type(e).__name__, e)
    try:
        print("video sources", await media.GetVideoSources())
    except Exception as e:
        print("video sources:", type(e).__name__, e)
    req = ptz.create_type("GetConfigurationOptions")
    req.ConfigurationToken = p.PTZConfiguration.token
    opts = await ptz.GetConfigurationOptions(req)
    print("spaces", opts.Spaces.ContinuousPanTiltVelocitySpace[0].URI, opts.Spaces.RelativePanTiltTranslationSpace)
    presets = await ptz.GetPresets({"ProfileToken": p.token})
    print("presets", [(x.Name, x["token"]) for x in presets])
    if action in ("left", "right", "up", "down"):
        mr = ptz.create_type("ContinuousMove")
        mr.ProfileToken = p.token
        mr.Velocity = {"PanTilt": {"left": {"x": -0.5, "y": 0}, "right": {"x": 0.5, "y": 0}, "up": {"x": 0, "y": 0.5}, "down": {"x": 0, "y": -0.5}}[action]}
        await ptz.ContinuousMove(mr)
        await asyncio.sleep(float(sys.argv[4]) if len(sys.argv) > 4 else 0.2)
        await ptz.Stop({"ProfileToken": p.token, "PanTilt": True, "Zoom": True})
        print("moved", action)
    await cam.close()

asyncio.run(main(*sys.argv[1:4]))
