"""Provider-agnostic perception plugins for MetaViewer agents."""

__all__ = [
    "PerceptionAdapter",
    "PerceptionError",
    "Frame",
    "FakePerceptionAdapter",
    "frame_dims",
    "check_vision",
    "register_perception_adapter",
    "create_perception_adapter",
    "available_perception_adapters",
    "VCorePerceptionAdapter",
    "MetaMusePerceptionAdapter",
]

_BASE_NAMES = frozenset((
    "PerceptionAdapter",
    "PerceptionError",
    "Frame",
    "FakePerceptionAdapter",
    "frame_dims",
    "check_vision",
    "register_perception_adapter",
    "create_perception_adapter",
    "available_perception_adapters",
))


def __getattr__(name: str):
    """Resolve the documented names lazily so importing stays inert."""
    if name in _BASE_NAMES:
        from . import base

        return getattr(base, name)
    if name == "VCorePerceptionAdapter":
        from . import vcore

        return vcore.VCorePerceptionAdapter
    if name == "MetaMusePerceptionAdapter":
        from . import meta_muse

        return meta_muse.MetaMusePerceptionAdapter
    raise AttributeError(
        "module 'metaviewer_agents.perception' has no attribute %r" % (name,)
    )
