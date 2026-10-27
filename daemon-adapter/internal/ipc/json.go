package ipc

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"unicode/utf8"
)

func hasLoneSurrogateEscape(data []byte) bool {
	inString := false
	for i := 0; i < len(data); {
		b := data[i]
		if !inString {
			if b == '"' {
				inString = true
			}
			i++
			continue
		}
		if b == '"' {
			inString = false
			i++
			continue
		}
		if b != '\\' {
			i++
			continue
		}
		if i+1 >= len(data) {
			return false
		}
		if data[i+1] != 'u' {
			i += 2
			continue
		}
		if i+6 > len(data) {
			return false
		}
		hi, err := strconv.ParseUint(string(data[i+2:i+6]), 16, 16)
		if err != nil {
			return false
		}
		if hi >= 0xDC00 && hi <= 0xDFFF {
			return true
		}
		if hi >= 0xD800 && hi <= 0xDBFF {
			if i+12 > len(data) || data[i+6] != '\\' || data[i+7] != 'u' {
				return true
			}
			lo, err := strconv.ParseUint(string(data[i+8:i+12]), 16, 16)
			if err != nil || lo < 0xDC00 || lo > 0xDFFF {
				return true
			}
			i += 12
			continue
		}
		i += 6
	}
	return false
}

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
	if hasLoneSurrogateEscape(data) {
		return errors.New("lone surrogate escape")
	}
	return nil
}
