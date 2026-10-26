"""Public surface of the MetaViewer Python agent package."""

__all__ = ["build_parser", "run", "main"]


def __getattr__(name):
    """Resolve the documented names lazily so importing stays inert."""
    if name in __all__:
        from . import mvctl

        return getattr(mvctl, name)
    raise AttributeError(
        "module 'metaviewer_agents' has no attribute %r" % (name,)
    )
