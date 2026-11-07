"""
Test-only stand-in for the `blender` executable, backed by the official `bpy`
module (Blender built as a Python module, same engine). It implements exactly
the command-line subset the bridge uses:

    blender --version
    blender -b [file.blend] --python script.py --python-exit-code N

Used where a full Blender install is unavailable (CI containers). On a real
desktop the bridge calls the real Blender binary with the same arguments.
"""
import runpy
import sys
import traceback

import bpy  # noqa: E402

args = sys.argv[1:]
if "--version" in args:
    print(f"Blender {bpy.app.version_string}")
    sys.exit(0)

blend = None
script = None
exit_code = 1
i = 0
while i < len(args):
    a = args[i]
    if a in ("-b", "--background"):
        pass
    elif a == "--python":
        script = args[i + 1]
        i += 1
    elif a == "--python-exit-code":
        exit_code = int(args[i + 1])
        i += 1
    elif a.endswith(".blend"):
        blend = a
    i += 1

if blend:
    bpy.ops.wm.open_mainfile(filepath=blend)
if script:
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit as e:
        sys.exit(e.code if isinstance(e.code, int) else exit_code)
    except Exception:
        traceback.print_exc()
        sys.exit(exit_code)
sys.exit(0)
