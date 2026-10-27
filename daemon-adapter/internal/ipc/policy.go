package ipc

// [TARGET, unit decision] NewPolicy snapshots the supplied v0.2 schema filesystem.
// It implements the closed contract subset without network resolution. Authority
// operations remain mandatory caller-supplied capabilities (no local replay fallback).
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"
)

type Authority interface {
	Authenticate(context.Context, PeerCredentials, Envelope) error
	Reserve(context.Context, SenderKey, uint64, string) error
	Wrap(context.Context, Envelope, json.RawMessage) (Envelope, error)
}
type SchemaPolicy struct {
	Authority
	config   Config
	envelope *schemaNode
}

var _ Policy = (*SchemaPolicy)(nil)

var integerLexeme = regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`)

type schemaNode struct {
	ref      *schemaNode
	kind     string
	constant any
	hasConst bool
	enums    []any
	required []string
	props    map[string]*schemaNode
	closed   bool
	choices  []*schemaNode
	items    *schemaNode
	pattern  *regexp.Regexp
	limits   map[string]int
}

func NewPolicy(c Config, source fs.FS, authority Authority) (policy *SchemaPolicy, err error) {
	// Malformed deployment schemas are configuration failures, never partial admission.
	defer func() {
		if failure := recover(); failure != nil {
			policy = nil
			err = fmt.Errorf("malformed contract schema: %v", failure)
		}
	}()
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if source == nil || authority == nil {
		return nil, errors.New("schema filesystem and authority required")
	}
	documents := map[string]map[string]any{}
	cache := map[string]*schemaNode{}
	var compile func(map[string]any, string) (*schemaNode, error)
	var resolve func(string, string) (*schemaNode, error)
	resolve = func(ref, base string) (*schemaNode, error) {
		file, fragment, _ := strings.Cut(ref, "#")
		if file == "" {
			file = base
		}
		if !fs.ValidPath(file) || strings.Contains(file, "/") {
			return nil, errors.New("nonlocal schema reference")
		}
		key := file + "#" + fragment
		if n := cache[key]; n != nil {
			return n, nil
		}
		doc := documents[file]
		if doc == nil {
			raw, err := fs.ReadFile(source, file)
			if err != nil {
				return nil, err
			}
			d := json.NewDecoder(bytes.NewReader(raw))
			d.UseNumber()
			if err = d.Decode(&doc); err != nil {
				return nil, err
			}
			documents[file] = doc
		}
		var target any = doc
		if fragment != "" {
			if !strings.HasPrefix(fragment, "/") {
				return nil, errors.New("unsupported reference fragment")
			}
			for _, part := range strings.Split(fragment[1:], "/") {
				obj, ok := target.(map[string]any)
				if !ok {
					return nil, errors.New("invalid schema pointer")
				}
				part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
				target = obj[part]
			}
		}
		object, ok := target.(map[string]any)
		if !ok {
			return nil, errors.New("missing schema reference")
		}
		// Reject cycles rather than allowing recursive schema evaluation without a bound.
		cache[key] = &schemaNode{kind: "pending"}
		n, err := compile(object, file)
		if err != nil {
			return nil, err
		}
		*cache[key] = *n
		return cache[key], nil
	}
	compile = func(s map[string]any, base string) (*schemaNode, error) {
		n := &schemaNode{props: map[string]*schemaNode{}, limits: map[string]int{}}
		for k, v := range s {
			switch k {
			case "$schema", "$id", "title", "description", "$defs":
			case "$ref":
				r, ok := v.(string)
				if !ok {
					return nil, errors.New("invalid ref")
				}
				var err error
				n.ref, err = resolve(r, base)
				if err != nil {
					return nil, err
				}
				if n.ref.kind == "pending" {
					return nil, errors.New("cyclic schema")
				}
			case "type":
				var ok bool
				n.kind, ok = v.(string)
				if !ok {
					return nil, errors.New("unsupported type union")
				}
				switch n.kind {
				case "object", "array", "string", "integer", "number", "boolean", "null":
				default:
					return nil, errors.New("unsupported type")
				}
			case "const":
				n.constant = v
				n.hasConst = true
			case "enum":
				n.enums = v.([]any)
			case "required":
				for _, x := range v.([]any) {
					n.required = append(n.required, x.(string))
				}
			case "additionalProperties":
				b, ok := v.(bool)
				if !ok || b {
					return nil, errors.New("open schema refused")
				}
				n.closed = true
			case "properties":
				for name, x := range v.(map[string]any) {
					child, err := compile(x.(map[string]any), base)
					if err != nil {
						return nil, err
					}
					n.props[name] = child
				}
			case "items":
				var err error
				n.items, err = compile(v.(map[string]any), base)
				if err != nil {
					return nil, err
				}
			case "oneOf":
				choices := v.([]any)
				if len(choices) == 0 {
					return nil, errors.New("empty oneOf refused")
				}
				for _, x := range choices {
					child, err := compile(x.(map[string]any), base)
					if err != nil {
						return nil, err
					}
					n.choices = append(n.choices, child)
				}
			case "pattern":
				var err error
				n.pattern, err = regexp.Compile(strings.ReplaceAll(v.(string), `\u0000`, `\x{0000}`))
				if err != nil {
					return nil, err
				}
			case "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "maxProperties":
				i, err := v.(json.Number).Int64()
				if err != nil {
					return nil, err
				}
				n.limits[k] = int(i)
			default:
				return nil, fmt.Errorf("unsupported schema keyword %s", k)
			}
		}
		if (n.kind == "object" || len(n.props) > 0 || len(n.required) > 0) && (n.kind != "object" || !n.closed) {
			return nil, errors.New("open schema refused")
		}
		return n, nil
	}
	n, err := resolve("envelope.schema.json", "")
	if err != nil {
		return nil, err
	}
	if n.kind != "object" || !n.closed || n.props["schema"] == nil || n.props["schema"].constant != "envelope/v0.2" || n.props["body"] == nil || len(n.props["body"].choices) == 0 {
		return nil, errors.New("closed v0.2 envelope contract required")
	}
	return &SchemaPolicy{Authority: authority, config: c, envelope: n}, nil
}
func (p *SchemaPolicy) ValidateEnvelope(raw []byte) (Envelope, error) {
	var e Envelope
	if p == nil || p.envelope == nil {
		return e, errors.New("unconfigured schema policy")
	}
	if len(raw) > p.config.MaxFrameBytes {
		return e, errors.New("frame limit")
	}
	if err := ValidateJSON(raw, p.config); err != nil {
		return e, err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return e, err
	}
	if !p.envelope.accept(v) || !terminalLengthsOK(v) {
		return e, errors.New("closed v0.2 envelope/body refused")
	}
	err := json.Unmarshal(raw, &e)
	return e, err
}

func terminalLengthsOK(v any) bool {
	obj, ok := v.(map[string]any)
	if !ok {
		return true
	}
	if body, ok := obj["body"].(map[string]any); ok {
		obj = body
	}
	if obj["schema"] != "terminal_session/v0.2" {
		return true
	}
	op, _ := obj["op"].(string)
	if op != "data" && op != "write" {
		return true
	}
	params, ok := obj["params"].(map[string]any)
	if !ok {
		return false
	}
	b64, ok := params["b64"].(string)
	if !ok {
		return false
	}
	bcNum, ok := params["byte_count"].(json.Number)
	if !ok {
		return false
	}
	bc, err := bcNum.Int64()
	if err != nil {
		return false
	}
	pad := 0
	for i := len(b64) - 1; i >= 0 && b64[i] == '='; i-- {
		pad++
	}
	decodedLen := int64(len(b64)/4*3 - pad)
	return bc == decodedLen
}
func (n *schemaNode) accept(v any) bool {
	if n.ref != nil && !n.ref.accept(v) {
		return false
	}
	if n.hasConst && !reflect.DeepEqual(n.constant, v) {
		return false
	}
	if n.enums != nil {
		found := false
		for _, x := range n.enums {
			found = found || reflect.DeepEqual(x, v)
		}
		if !found {
			return false
		}
	}
	if n.choices != nil {
		count := 0
		for _, x := range n.choices {
			if x.accept(v) {
				count++
			}
		}
		if count != 1 {
			return false
		}
	}
	bounded := func(value int, lo, hi string) bool {
		a, hasLo := n.limits[lo]
		b, hasHi := n.limits[hi]
		return (!hasLo || value >= a) && (!hasHi || value <= b)
	}
	switch n.kind {
	case "":
		return true
	case "object":
		obj, ok := v.(map[string]any)
		if !ok || !bounded(len(obj), "", "maxProperties") {
			return false
		}
		for _, key := range n.required {
			if _, ok := obj[key]; !ok {
				return false
			}
		}
		for key, x := range obj {
			child, ok := n.props[key]
			if !ok {
				if n.closed {
					return false
				}
			} else if !child.accept(x) {
				return false
			}
		}
	case "array":
		a, ok := v.([]any)
		if !ok || !bounded(len(a), "minItems", "maxItems") {
			return false
		}
		for _, x := range a {
			if n.items != nil && !n.items.accept(x) {
				return false
			}
		}
	case "string":
		s, ok := v.(string)
		if !ok || !bounded(utf8.RuneCountInString(s), "minLength", "maxLength") || (n.pattern != nil && !n.pattern.MatchString(s)) {
			return false
		}
	case "integer", "number":
		num, ok := v.(json.Number)
		if !ok {
			return false
		}
		r, ok := new(big.Rat).SetString(string(num))
		if !ok {
			return false
		}
		if n.kind == "integer" && (!integerLexeme.MatchString(string(num)) || !r.IsInt() || r.Cmp(big.NewRat(9007199254740991, 1)) > 0 || r.Cmp(big.NewRat(-9007199254740991, 1)) < 0) {
			return false
		}
		if a, ok := n.limits["minimum"]; ok && r.Cmp(big.NewRat(int64(a), 1)) < 0 {
			return false
		}
		if b, ok := n.limits["maximum"]; ok && r.Cmp(big.NewRat(int64(b), 1)) > 0 {
			return false
		}
	case "boolean":
		if _, ok := v.(bool); !ok {
			return false
		}
	case "null":
		if v != nil {
			return false
		}
	default:
		return false
	}
	return true
}
