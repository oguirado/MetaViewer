package ipc

import (
	"os"
	"path/filepath"
	"testing"
)

// Graphical additions have independent content pins; all prior pins remain unchanged.
var graphicalFixturePins = map[string]string{
	"graphical_session.invalid.extra.json":                                 "4e7c3fb9298396f18ff32328af0bfc29d4bfdb05b9640d0a514716edf7926210",
	"graphical_session.invalid.runtime-id.json":                            "ca91d4fabf3233ae0fa02705c3ad176e7ff7ea32eec0bd8a061597b81829c47a",
	"graphical_session.valid.outcome_unknown.json":                         "a7409cdbcf22a45781fcb9f2b7c30cbbf1b289dcb838b85d78227260af81130b",
	"graphical_session.valid.pending.json":                                 "c0a9e68b55162f8bac65789b5b032374b8a0dfb96a39f9a702a123bb07cef7a9",
	"graphical_session.valid.ready.json":                                   "1b3dadefc4c4f8e5a143a4af0c20414636bd95883786b06fd23eb2492e0446ac",
	"graphical_session.valid.stopped.json":                                 "853f6c359d242fd6045337c576976381f8c6c18e7c753c0013fd4bae1063cf4f",
	"graphical_session.valid.stopping.json":                                "a6864b627acb227e4f073cd62d3f6f0f1ee69d912468483e9cbbfb93dca14726",
	"graphical_session_envelope.invalid.agent.json":                        "26ae576fc3805ae5f79cbf4d3659e37b5db2835e02dea056fe96e8f23f5a361d",
	"graphical_session_envelope.valid.attach_accepted_unbound.json":        "5c386173e42797738eca1293dc9c33b25fafe6bbcf452d9fa495b65f4e0668e7",
	"graphical_session_envelope.valid.attach_outcome_unknown_unbound.json": "15dda4fa1877a89fc8f45fa34ce95c82000cb24f3d9303fdcbefcbb4b24c9841",
	"graphical_session_envelope.valid.flow-1.json":                         "7d235a16dc30de7be782676da9f2e6f7609b8f70bbea1384889d6090edf2c602",
	"graphical_session_envelope.valid.flow-10.json":                        "24e5c560bdfd25d69ce7f3c276397c9b827e1504fdf0bf3e4c3c5c9f159baf03",
	"graphical_session_envelope.valid.flow-11.json":                        "0afb97bd8bd50d9078c74aae51d708aa2da56b7c00cde806ee2babc1d7c1f828",
	"graphical_session_envelope.valid.flow-12.json":                        "d9cb166c5b69b0f1e70cafccdbf76d388503807dbc59e76fddb00c7cfb2bdfcc",
	"graphical_session_envelope.valid.flow-13.json":                        "ae5c7492e01173c6c08fbd2b0b33fd7b1acf01c21be39fd51671a2bf403e6f8c",
	"graphical_session_envelope.valid.flow-14.json":                        "a015004f67c9062811c1e8e1a947621d20bbcc6dd68e2e2f0c5848d169508ff0",
	"graphical_session_envelope.valid.flow-15.json":                        "d46fe100961ba9d3f307b8db8b4e262b65403acbed86882f37194bb8ad142929",
	"graphical_session_envelope.valid.flow-16.json":                        "6480552d0e4e1afcad759d3c0aef83cb03eb9cd1f97127e3e23f53264d6a3bee",
	"graphical_session_envelope.valid.flow-2.json":                         "981161c3e395434046c2303d5d1d048eec0fadd72dce2d0507ad53b849eeb033",
	"graphical_session_envelope.valid.flow-3.json":                         "c1cc9252e3787e5093f4041e9a1c2a3e78102584858ca87a699ed60a4e33fe72",
	"graphical_session_envelope.valid.flow-4.json":                         "050bed1a9dcad1f3d133fe0a3e8bf51405b98ef5495a49fd0aa8c625a22bb6b8",
	"graphical_session_envelope.valid.flow-5.json":                         "105aa1570de19590ee44bfbbdb8c79ddcbea8ecd8de62d4fdee9ffb6386e2f21",
	"graphical_session_envelope.valid.flow-6.json":                         "6c00d7ba2d02a8b0344e6139fffeaf1e795091ff1d3ee8a17254827956d55efd",
	"graphical_session_envelope.valid.flow-7.json":                         "ad8617aef504946789d6387857c1b6d23fb3ec0aaa07940b9ef25927982c98d6",
	"graphical_session_envelope.valid.flow-8.json":                         "69d4314fbb0b0f9a42ee9ec0b4a109eb96adc196469b8c7b4189d738077ba599",
	"graphical_session_envelope.valid.flow-9.json":                         "44b2264656cfc053a125cfce7837df720dba532d3a3b4d04d0439edd7489c72c",
	"graphical_session_envelope.valid.refused-live-mark.json":              "040d84c66ea0c04839c945191b743e807a4a85119f715cea5aa8d9e334055871",
	"graphical_session_envelope.valid.refused-live-restore.json":           "41a1c95eff6b127cce6a517a0575f30a4bc573f83ed8bc0691227ddc3e00e13b",
	"graphical_session_event.invalid.completed-refusal.json":               "8bd6a1429b74e0c9c0e7ca0e3d03ce12cea8fae0a8221449b45ba57707eefe21",
	"graphical_session_event.invalid.elapsed-over-limit.json":              "a7b9bc61db7ea8e98eb921dfd5cf54dbe4e46863517129c6f9d0a5cd7e932c7d",
	"graphical_session_event.invalid.refused-point.json":                   "7dfea57a517bafaced83ab9254e4e6548be19f2b8a03126246d50cb3f3dadb5b",
	"graphical_session_event.invalid.refused-unknown-code.json":            "b6f3c65c36dc4ce86449b53aec9a355dfc6a753a970d2f89f711caec7f630e0b",
	"graphical_session_event.invalid.restore-frame-missing.json":           "17bc4511c5b72c35cb0cf8fc1e91b65129a768a3e69a548839f9b2a71d867646",
	"graphical_session_event.valid.attach-accepted.json":                   "8c35b1d2d2c200951a10cf8a2ab3a7a5d27a3df2fc5b42e08a128f5fb8fdc624",
	"graphical_session_event.valid.attach-completed.json":                  "56618f7f1132c07a61bfce4efa8cb3d2f097c177034bfe3c07d42b85e5d58517",
	"graphical_session_event.valid.attach-outcome_unknown.json":            "daeb84f062bd000acc54e0f3df513fbd859570d8f34cfe8fdb23fa7a52631773",
	"graphical_session_event.valid.attach-refused-live.json":               "1efabf773a4ae9a30051452de4de8da406dc4b3f6d61549764993b8061255605",
	"graphical_session_event.valid.attach-refused.json":                    "92eee3d03b81d2b802af868707236a6212da3216936df72f5b558a2f3a875372",
	"graphical_session_event.valid.attach_accepted_unbound.json":           "818c31eb8e138fefd7886ec5954c4854152f71f5fede2c337c6958fa03e7469a",
	"graphical_session_event.valid.attach_outcome_unknown_unbound.json":    "79e9c298aaf1cce454399524756cbe3af759f52df0f14e26a82803eeaadaf8b0",
	"graphical_session_event.valid.mark-accepted.json":                     "4aba799c8246bdc2f86a242e685f776cf0bcea6b3147b7382ca22b8360887a3d",
	"graphical_session_event.valid.mark-completed.json":                    "0d58e58dbf391a2bc04dc2c7bd47d3c872e63c1b6c17d4c3963daa00bfdb2d23",
	"graphical_session_event.valid.mark-outcome_unknown.json":              "0257af88319b05ee1de85a1236d180b2cd6cb932b586fbe0bae7e28e4be0c088",
	"graphical_session_event.valid.mark-refused-live.json":                 "4bfec80d853732c069bac360daf3dd8618591c0c7c84cef1889825a6474e833c",
	"graphical_session_event.valid.mark-refused.json":                      "1b431b6a483aabeb29c6b9c27467b21f4fb2da727c1604141628ebe8c9a54d3d",
	"graphical_session_event.valid.restore-accepted.json":                  "6de121cb84b5e2ed4693bde7a3c22fcfc8baee4666ba9ec156bbd95bf67604b4",
	"graphical_session_event.valid.restore-completed.json":                 "70d5f6d792c2b2aa17c5b4292b924b119d837697748b29ff4f8221b6b3a01675",
	"graphical_session_event.valid.restore-outcome_unknown.json":           "d2b42a1e77de3928e7be76df01989b1562c243cfd33752342b7dcd39aed15810",
	"graphical_session_event.valid.restore-refused-live.json":              "f15e823a62977269b68dba4745482873acc6c8b22404c807bfb5fa9ff6b6f02c",
	"graphical_session_event.valid.restore-refused.json":                   "7ddc7a8cd232f4091bbb63063697ad494df538c59b3ffae2fae586a03d8f7fff",
	"graphical_session_request.invalid.extra.json":                         "1fc0542cc429d06acc5ab73030ae1d22a5eb2f5ac51b95910a53b0181d309606",
	"graphical_session_request.invalid.missing-fence.json":                 "5aacab01e574bc151b74a2be02f7d30bfd9588751f86bc8a253f47c23b3cb1dc",
	"graphical_session_request.invalid.owner-shape.json":                   "8f3243d13e5459d6642d8e14bdee326b3c557735b6e5bdae29ee36ed53555002",
	"graphical_session_request.valid.attach.json":                          "d5733af21fc5084d1f3e36f8a532ce637070d020c94c111559fe4e717b1f9119",
	"graphical_session_request.valid.mark.json":                            "a1a1a5054a16528fe486ec4db9e0b17a62be0584173c60092764930636224d88",
	"graphical_session_request.valid.restore.json":                         "9a6530297dc3cbbcfaaf514b0b35b27b9b366af0744552a25c45684f5a935afc",
}

func TestGraphicalFixturePinsRejectChangeMissingAndUnknown(t *testing.T) {
	source := "../../../contracts/examples/v0.2"
	dir := t.TempDir()
	entries, err := os.ReadDir(source)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		raw, e := os.ReadFile(filepath.Join(source, entry.Name()))
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(dir, entry.Name()), raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	check := func() error { _, e := verifyContractFixtureCorpus(dir, "../../../contracts/v0.2"); return e }
	if e := check(); e != nil {
		t.Fatal("nominal corpus", e)
	}
	if len(graphicalFixturePins) != 56 {
		t.Fatal("closed graphical fixture count")
	}
	for name := range graphicalFixturePins {
		path := filepath.Join(dir, name)
		raw, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(path, append(append([]byte(nil), raw...), ' '), 0600); e != nil {
			t.Fatal(e)
		}
		if check() == nil {
			t.Fatal("changed graphical accepted", name)
		}
		if e = os.Remove(path); e != nil {
			t.Fatal(e)
		}
		if check() == nil {
			t.Fatal("missing graphical accepted", name)
		}
		if e = os.WriteFile(path, raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	if e := os.WriteFile(filepath.Join(dir, "graphical_session_unknown.valid.json"), []byte(`{}`), 0600); e != nil {
		t.Fatal(e)
	}
	if check() == nil {
		t.Fatal("unknown graphical accepted")
	}
}
