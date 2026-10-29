package capsule

// Native start owns dedicated proxy lifecycle and
// isolation. This module never starts a proxy or requests an audit log.
import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"metaviewer/daemon-adapter/internal/cli"
)

func WriteEgressPolicy(state, identity, capsule string, e Egress) (string, error) {
	if err := e.Validate(); err != nil {
		return "", err
	}
	if e.Mode != "allowlisted" || !profileID.MatchString(identity) || !identityContainer.MatchString(capsule) {
		return "", fault("NET_EGRESS_INVALID", "allowlisted capsule required")
	}
	path, err := writeEgressFile(state, identity+".policy.json", struct {
		Schema   string              `json:"schema"`
		Approved map[string][]string `json:"approved"`
		Denied   []string            `json:"denied"`
	}{"browserid.proxy-policy/v1", map[string][]string{capsule: e.Domains}, []string{}})
	if err != nil {
		return "", err
	}
	if err := verifyEgressRecord(state, identity, e); err != nil {
		return "", err
	}
	return path, nil
}

// [TARGET, unit decision] Re-read after publication; never start with a stale policy.
func verifyEgressRecord(state, identity string, expected Egress) error {
	current, err := LoadEgress(state, identity)
	if err != nil || current.Schema != expected.Schema || current.Mode != expected.Mode || !slices.Equal(current.Domains, expected.Domains) {
		return fault("NET_EGRESS_CHANGED", "egress record changed during network preparation")
	}
	return nil
}

type networkModeKey struct{}

func (m *Manager) browserNetwork(identity, capsule string) (Egress, string, string, error) {
	e := Egress{Schema: egressSchema, Mode: "open", Domains: []string{}}
	r, native := m.runner.(*ProcessRunner)
	// [TARGET, unit decision] Injected runners may retain legacy only without
	// an allowlist. Use the trusted deployment state directory when configured.
	if !native {
		if state, present := os.LookupEnv("MV_SRF_STATE_DIR"); present {
			var err error
			e, err = LoadEgress(state, identity)
			if err != nil {
				return e, "", "", err
			}
			if e.Mode == "allowlisted" {
				return e, "", "", fault("NET_PROXIED_UNSUPPORTED", "allowlisted egress requires native runner")
			}
		}
		return e, "", "", nil
	}
	if err := r.validateStateDir(); err != nil {
		return e, "", "", err
	}
	var err error
	e, err = LoadEgress(r.stateDir, identity)
	if err != nil {
		return e, "", "", err
	}
	modes := map[string]bool{}
	for _, mode := range m.cfg.NetModes {
		modes[mode] = true
	}
	mode := "open"
	if e.Mode == "allowlisted" {
		mode = "proxied"
	}
	if !modes[mode] {
		if e.Mode == "allowlisted" {
			return e, "", "", fault("NET_PROXIED_UNSUPPORTED", "trusted capability declaration lacks proxied")
		}
		return e, "legacy", "", nil
	}
	policy := ""
	if mode == "proxied" {
		if _, err := proxyExecutable(r); err != nil {
			return e, "", "", err
		}
		policy, err = WriteEgressPolicy(r.stateDir, identity, capsule, e)
	} else {
		err = verifyEgressRecord(r.stateDir, identity, e)
	}
	return e, mode, policy, err
}

// Accepted os-cu-0 v1: browser start --net open|proxied --policy <file>.
func networkStartArgs(args []string, mode, policy string) ([]string, error) {
	switch mode {
	case "", "legacy":
		return args, nil
	case "open":
		return append(args, "--net", "open"), nil
	case "proxied":
		if policy == "" {
			return nil, fault("NET_EGRESS_INVALID", "proxied start requires policy")
		}
		return append(args, "--net", "proxied", "--policy", policy), nil
	default:
		return nil, fault("NET_EGRESS_INVALID", "unknown network mode")
	}
}

// Clone trusted runner configuration for this call; never mutate shared env.
func networkRunner(r *ProcessRunner, mode string) cli.Runner {
	copyRunner := *r
	if mode == "open" || mode == "proxied" {
		copyRunner.env = nil
		for _, v := range r.env {
			if !strings.HasPrefix(v, "SRF_EGRESS_PROXY=") {
				copyRunner.env = append(copyRunner.env, v)
			}
		}
	}
	return &browserNetworkRunner{runner: &copyRunner, mode: mode}
}

// [TARGET, unit decision] The execution seam owns --proxy-bin so its path uses
// the captured MV_SRF_BIN_DIR, never request data or a later environment change.
// browserNetwork also checks it before policy publication and quarantine.
func proxyExecutable(r *ProcessRunner) (string, error) {
	path := filepath.Join(r.root, "srf-egress-proxy")
	st, err := os.Stat(path)
	if !filepath.IsAbs(path) || err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0111 == 0 {
		return "", fault("NET_EGRESS_INVALID", "proxied start requires an executable srf-egress-proxy in MV_SRF_BIN_DIR")
	}
	return path, nil
}

type browserNetworkRunner struct {
	runner *ProcessRunner
	mode   string
}

func (r *browserNetworkRunner) Run(ctx context.Context, argv []string, stdin []byte) ([]byte, error) {
	start := len(argv) > 1 && filepath.Base(argv[0]) == "srf-identity-surface" && argv[1] == "start"
	if start && r.mode == "proxied" {
		proxy, err := proxyExecutable(r.runner)
		if err != nil {
			return nil, &preSpawnRefusal{err}
		}
		argv = append(append([]string(nil), argv...), "--proxy-bin", proxy)
	}
	out, err := r.runner.Run(ctx, argv, stdin)
	var native *cli.Fault
	if start && r.mode == "open" && errors.As(err, &native) && native.Code == "setup" {
		return out, fault("NET_OPEN_PREREQ", "native start exit code 3: operator-approved identity image rebuild (SRF_NET_MODE=open entrypoint) + root-owned firewall witness matching operator-installed DOCKER-USER/INPUT rules required")
	}
	return out, err
}
