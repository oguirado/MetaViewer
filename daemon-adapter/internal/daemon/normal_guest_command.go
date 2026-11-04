package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"runtime"

	"metaviewer/daemon-adapter/internal/guestcommand"
	"metaviewer/daemon-adapter/internal/ipc"
	"metaviewer/daemon-adapter/internal/resourceinventory"
)

func normalGuestCommandFromEnv() (guestCommandOwner, error) {
	if os.Getenv("MV_REWIND_ENABLED") == "1" {
		owner, err := guestcommand.NewRewindFromEnv()
		if err != nil {
			return nil, err
		}
		inventory, err := resourceinventory.OpenFromEnv("guestcommand")
		if err != nil {
			_ = owner.Close()
			return nil, err
		}
		if err = owner.SetInventory(inventory); err != nil {
			_ = owner.Close()
			return nil, err
		}
		return owner, nil
	}
	mode := os.Getenv("MV_ARM64_CAPSULES")
	if mode == "" {
		return nil, nil
	}
	if mode != "1" || runtime.GOARCH != "arm64" {
		return nil, configuration("ARM64 capsule setup mode refused")
	}
	owner, err := guestcommand.NewFromEnv()
	if err != nil {
		return nil, configuration("guest command profile: " + err.Error())
	}
	if owner == nil {
		return nil, configuration("ARM64 capsule setup requires guest command profile")
	}
	inventory, err := resourceinventory.OpenFromEnv("guestcommand")
	if err != nil {
		_ = owner.Close()
		return nil, configuration(err.Error())
	}
	if err = owner.SetInventory(inventory); err != nil {
		if inventory != nil {
			_ = inventory.Seal()
		}
		_ = owner.Close()
		return nil, configuration(err.Error())
	}
	return owner, nil
}

func routeGuestCommand(ctx context.Context, owner guestCommandOwner, policy ipc.Policy, in ipc.Envelope) ([]json.RawMessage, error) {
	if owner == nil {
		return nil, errors.New("guest command profile unavailable")
	}
	stream, ok := ctx.Value(streamKey{}).(streamSession)
	if !ok || stream.emit == nil {
		return nil, errors.New("guest command streaming session required")
	}
	return owner.Handle(ctx, in.Body, in.SessionID, func(body json.RawMessage) error {
		out := in
		out.Schema = ipc.EnvelopeSchema(body)
		out.From, out.To = out.To, out.From
		out.Body = body
		raw, err := json.Marshal(out)
		if err != nil {
			return err
		}
		_, err = policy.ValidateEnvelope(raw)
		return err
	}, func(body json.RawMessage) error { return stream.emit(stream.ctx, body) })
}
