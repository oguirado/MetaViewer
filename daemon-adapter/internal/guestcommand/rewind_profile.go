package guestcommand

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

func validateRewindTemplate(raw []byte) error {
	var c struct {
		Schema    string         `json:"schema"`
		Owner     string         `json:"owner_id"`
		Admitted  *bool          `json:"runtime_admitted"`
		Artifacts map[string]Pin `json:"artifacts"`
		Root      string         `json:"runtime_root"`
		Cgroup    string         `json:"external_cgroup"`
		Startup   int            `json:"startup_seconds"`
		Stop      int            `json:"stop_seconds"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil || d.Decode(new(any)) != io.EOF || c.Schema != "rewind-host-config/v1" || c.Admitted == nil || !ownerPattern.MatchString(c.Owner) || c.Startup < 1 || c.Startup > 10 || c.Stop < 1 || c.Stop > 10 || len(c.Artifacts) != 4 {
		return errors.New("rewind template contract")
	}
	if canonical(c.Root) != nil || canonical(c.Cgroup) != nil {
		return errors.New("rewind template paths")
	}
	pins := map[string]string{"engine": "fe726e0b43c04363ac07e358be4dee982c3947c65ed3ae10c770fef5e1cd756c", "kernel": "43597af54cfbca19bcd7d7d91666a0a55e5a33632eada679827b9ac43393edcf", "broker": "0b3a451d79a01d74497038d48b9d2d5c3e47c645bb873d2c5cd2b0f7d66cd5c6", "busybox": "52151e7f322f926b64049cdaa1410dc3ea6485525e0624b05813791c219ae933"}
	for k, sha := range pins {
		p, ok := c.Artifacts[k]
		if !ok || canonical(p.Path) != nil || p.SHA256 != sha {
			return errors.New("rewind artifact pin")
		}
	}
	return nil
}
