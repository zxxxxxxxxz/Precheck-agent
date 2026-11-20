package hsbc.health

import rego.v1

# Runtime-created bundle manifests, not caller-supplied rule version echoes.
loaded := {
    "engine_version": opa.runtime().version,
    "bundles": {root: bundle.manifest.revision |
        some bundle in data.system.bundles
        some root in bundle.manifest.roots
        startswith(root, "hsbc/releases/")
    },
}
