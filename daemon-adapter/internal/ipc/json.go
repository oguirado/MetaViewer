package ipc

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

// ValidateJSON bounds decoded containers and rejects keys that decoders otherwise overwrite.
func ValidateJSON(data []byte, c Config) error {
	if len(data) == 0 || !utf8.Valid(data) {
		return errors.New("invalid JSON encoding")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var visit func(int) error
	visit = func(depth int) error {
		tok, err := d.Token()
		if err != nil {
			return err
		}
		switch v := tok.(type) {
		case string:
			if len(v) > c.MaxStringBytes {
				return errors.New("string limit")
			}
		case json.Delim:
			if depth >= c.MaxDepth {
				return errors.New("depth limit")
			}
			count := 0
			keys := make(map[string]bool)
			for d.More() {
				count++
				if v == '{' {
					if count > c.MaxKeys {
						return errors.New("key limit")
					}
					key, err := d.Token()
					if err != nil {
						return err
					}
					s, ok := key.(string)
					if !ok || keys[s] || len(s) > c.MaxStringBytes {
						return errors.New("invalid or duplicate key")
					}
					keys[s] = true
				} else if v == '[' {
					if count > c.MaxArrayItems {
						return errors.New("array limit")
					}
				} else {
					return errors.New("unexpected delimiter")
				}
				if err := visit(depth + 1); err != nil {
					return err
				}
			}
			end, err := d.Token()
			if err != nil {
				return err
			}
			if (v == '{' && end != json.Delim('}')) || (v == '[' && end != json.Delim(']')) {
				return errors.New("unclosed container")
			}
		}
		return nil
	}
	if err := visit(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("extra JSON value")
	}
	return nil
}
