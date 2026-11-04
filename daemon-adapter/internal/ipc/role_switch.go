package ipc

import "regexp"

// roleSwitchEnvelope copies the frozen transport header into an explicitly
// versioned, closed family. No body is added to envelope/v0.2.
func roleSwitchEnvelope(base *schemaNode) *schemaNode {
	literal := func(value any) *schemaNode { return &schemaNode{hasConst: true, constant: value} }
	id := func() *schemaNode {
		return &schemaNode{kind: "string", limits: map[string]int{"minLength": 1, "maxLength": 128}, pattern: regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)}
	}
	role := &schemaNode{kind: "string", enums: []any{"human", "agent"}}
	body := func(schema string, success *bool) *schemaNode {
		n := &schemaNode{kind: "object", closed: true, props: map[string]*schemaNode{"schema": literal(schema), "request_id": id(), "surface_id": id(), "role": role}, required: []string{"schema", "request_id", "surface_id", "role"}}
		if success != nil {
			n.props["ok"] = literal(*success)
			n.required = append(n.required, "ok")
			if !*success {
				n.props["code"] = &schemaNode{kind: "string", limits: map[string]int{"minLength": 1, "maxLength": 64}, pattern: regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)}
				n.required = append(n.required, "code")
			}
		}
		return n
	}
	yes, no := true, false
	root := *base
	root.props = map[string]*schemaNode{}
	for name, node := range base.props {
		root.props[name] = node
	}
	root.props["schema"] = literal("role_switch_envelope/v0.3")
	root.props["body"] = &schemaNode{choices: []*schemaNode{body("metaviewer.role_switch/v0.3", nil), body("metaviewer.role_switch_result/v0.3", &yes), body("metaviewer.role_switch_result/v0.3", &no)}}
	return &root
}

func roleSwitchRoute(obj map[string]any) bool {
	body, ok := obj["body"].(map[string]any)
	if !ok {
		return false
	}
	from, ok := obj["from"].(map[string]any)
	if !ok {
		return false
	}
	to, ok := obj["to"].(map[string]any)
	if !ok {
		return false
	}
	if body["schema"] == "metaviewer.role_switch/v0.3" {
		return from["component"] == "core" && to["component"] == "daemon"
	}
	return body["schema"] == "metaviewer.role_switch_result/v0.3" && from["component"] == "daemon" && to["component"] == "core"
}
