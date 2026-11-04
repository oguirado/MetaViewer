package daemon

import (
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/resourceinventory"
)

// A disabled normal-mode producer must remain a nil interface. Wrapping a nil
// pointer in the interface would enable hooks on unchanged legacy managers.
func nativeInventoryOrNil(value *resourceinventory.Graphical) capsule.NativeInventory {
	if value == nil {
		return nil
	}
	return value
}
