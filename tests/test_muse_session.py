import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import time

SCRIPT = Path(__file__).resolve().parents[1] / 'tools' / 'muse_session.py'

class MuseSessionTests(unittest.TestCase):
    def test_fresh_private_workspace_and_cleanup_on_normal_and_error_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            identity = parent / 'identities'; identity.mkdir(mode=0o700)
            output = parent / 'seen.jsonl'
            app = parent / 'app'
            app.write_text('#!' + sys.executable + '\nimport os,json,stat\nfrom pathlib import Path\np=Path(os.environ["MV_MUSE_WORKSPACE"])\nwith open(os.environ["TEST_OUTPUT"],"a") as f:f.write(json.dumps({"root":str(p),"mode":stat.S_IMODE(p.stat().st_mode),"runtime":os.environ["XDG_RUNTIME_DIR"],"home":os.environ["HOME"],"mw":os.environ["MV_MW_HOME"],"entries":sorted(x.name for x in p.iterdir())})+"\\n")\nraise SystemExit(int(os.environ["TEST_EXIT"]))\n')
            app.chmod(0o700)
            for code in (0,7):
                env = dict(os.environ, XDG_RUNTIME_DIR=str(parent), SRF_IDENTITY_STORE_ROOT=str(identity), TEST_OUTPUT=str(output), TEST_EXIT=str(code))
                run = subprocess.run([sys.executable,str(SCRIPT),'--app',str(app)],env=env,capture_output=True,text=True)
                self.assertEqual(run.returncode,code,run.stderr)
            rows=[json.loads(x) for x in output.read_text().splitlines()]
            self.assertNotEqual(rows[0]['root'],rows[1]['root'])
            for row in rows:
                self.assertEqual(row['mode'],0o700)
                self.assertEqual(row['runtime'],row['root'])
                self.assertEqual(row['home'],os.environ['HOME'])
                self.assertEqual(row['mw'],row['root']+'/memoryweb')
                self.assertEqual(row['entries'],['.owner.json','memoryweb'])
                self.assertFalse(Path(row['root']).exists())

    def test_permissive_runtime_is_refused_without_repair_or_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            parent=Path(directory);parent.chmod(0o755)
            run=subprocess.run([sys.executable,str(SCRIPT),'--app',sys.executable],env=dict(os.environ,XDG_RUNTIME_DIR=str(parent)),capture_output=True,text=True)
            self.assertNotEqual(run.returncode,0)
            self.assertEqual(list(parent.iterdir()),[])
            self.assertEqual(parent.stat().st_mode&0o777,0o755)

    def test_termination_waits_for_child_then_removes_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            parent=Path(directory)
            identity=parent/'identities';identity.mkdir(mode=0o700)
            witness=parent/'workspace'
            app=parent/'app'
            app.write_text('#!'+sys.executable+'\nimport os,time\nfrom pathlib import Path\nPath(os.environ["TEST_OUTPUT"]).write_text(os.environ["MV_MUSE_WORKSPACE"])\ntime.sleep(60)\n')
            app.chmod(0o700)
            env=dict(os.environ,XDG_RUNTIME_DIR=str(parent),SRF_IDENTITY_STORE_ROOT=str(identity),TEST_OUTPUT=str(witness))
            process=subprocess.Popen([sys.executable,str(SCRIPT),'--app',str(app)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                for _ in range(100):
                    if witness.exists():break
                    time.sleep(.02)
                self.assertTrue(witness.exists())
                workspace=Path(witness.read_text())
                process.terminate()
                process.communicate(timeout=5)
                self.assertFalse(workspace.exists())
            finally:
                if process.poll() is None:process.kill();process.communicate()

if __name__ == '__main__': unittest.main()
