package cn.hmremote.bridge;

import java.util.LinkedHashMap;
import java.util.Map;

final class MiniJson {
    private MiniJson() {}

    static Map<String, Object> parseObject(String text) {
        Parser parser = new Parser(text);
        Object value = parser.parseValue();
        parser.skipWhitespace();
        if (!(value instanceof Map<?, ?> map) || !parser.atEnd()) {
            throw new IllegalArgumentException("Expected one JSON object");
        }
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }

    static String stringify(Map<String, ?> value) {
        StringBuilder output = new StringBuilder();
        writeValue(output, value);
        return output.toString();
    }

    private static void writeValue(StringBuilder output, Object value) {
        if (value == null) {
            output.append("null");
        } else if (value instanceof String string) {
            writeString(output, string);
        } else if (value instanceof Number || value instanceof Boolean) {
            output.append(value);
        } else if (value instanceof Map<?, ?> map) {
            output.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) {
                    output.append(',');
                }
                first = false;
                writeString(output, String.valueOf(entry.getKey()));
                output.append(':');
                writeValue(output, entry.getValue());
            }
            output.append('}');
        } else {
            writeString(output, String.valueOf(value));
        }
    }

    private static void writeString(StringBuilder output, String value) {
        output.append('"');
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (ch < 0x20) {
                        output.append(String.format("\\u%04x", (int) ch));
                    } else {
                        output.append(ch);
                    }
                }
            }
        }
        output.append('"');
    }

    private static final class Parser {
        private final String text;
        private int position;

        private Parser(String text) {
            this.text = text;
        }

        private boolean atEnd() {
            return position == text.length();
        }

        private void skipWhitespace() {
            while (position < text.length() && Character.isWhitespace(text.charAt(position))) {
                position++;
            }
        }

        private Object parseValue() {
            skipWhitespace();
            if (position >= text.length()) {
                throw new IllegalArgumentException("Unexpected end of JSON");
            }
            return switch (text.charAt(position)) {
                case '{' -> parseObjectInternal();
                case '"' -> parseString();
                case 't' -> parseLiteral("true", true);
                case 'f' -> parseLiteral("false", false);
                case 'n' -> parseLiteral("null", null);
                default -> parseNumber();
            };
        }

        private Map<String, Object> parseObjectInternal() {
            expect('{');
            Map<String, Object> result = new LinkedHashMap<>();
            skipWhitespace();
            if (peek('}')) {
                position++;
                return result;
            }
            while (true) {
                skipWhitespace();
                String key = parseString();
                skipWhitespace();
                expect(':');
                result.put(key, parseValue());
                skipWhitespace();
                if (peek('}')) {
                    position++;
                    return result;
                }
                expect(',');
            }
        }

        private String parseString() {
            expect('"');
            StringBuilder result = new StringBuilder();
            while (position < text.length()) {
                char ch = text.charAt(position++);
                if (ch == '"') {
                    return result.toString();
                }
                if (ch != '\\') {
                    result.append(ch);
                    continue;
                }
                if (position >= text.length()) {
                    throw new IllegalArgumentException("Invalid JSON escape");
                }
                char escaped = text.charAt(position++);
                switch (escaped) {
                    case '"' -> result.append('"');
                    case '\\' -> result.append('\\');
                    case '/' -> result.append('/');
                    case 'b' -> result.append('\b');
                    case 'f' -> result.append('\f');
                    case 'n' -> result.append('\n');
                    case 'r' -> result.append('\r');
                    case 't' -> result.append('\t');
                    case 'u' -> {
                        if (position + 4 > text.length()) {
                            throw new IllegalArgumentException("Invalid unicode escape");
                        }
                        result.append((char) Integer.parseInt(text.substring(position, position + 4), 16));
                        position += 4;
                    }
                    default -> throw new IllegalArgumentException("Invalid JSON escape");
                }
            }
            throw new IllegalArgumentException("Unterminated JSON string");
        }

        private Object parseLiteral(String literal, Object value) {
            if (!text.startsWith(literal, position)) {
                throw new IllegalArgumentException("Invalid JSON literal");
            }
            position += literal.length();
            return value;
        }

        private Number parseNumber() {
            int start = position;
            if (peek('-')) {
                position++;
            }
            while (position < text.length() && Character.isDigit(text.charAt(position))) {
                position++;
            }
            boolean decimal = false;
            if (peek('.')) {
                decimal = true;
                position++;
                while (position < text.length() && Character.isDigit(text.charAt(position))) {
                    position++;
                }
            }
            if (peek('e') || peek('E')) {
                decimal = true;
                position++;
                if (peek('+') || peek('-')) {
                    position++;
                }
                while (position < text.length() && Character.isDigit(text.charAt(position))) {
                    position++;
                }
            }
            String number = text.substring(start, position);
            if (number.isEmpty() || "-".equals(number)) {
                throw new IllegalArgumentException("Invalid JSON number");
            }
            return decimal ? Double.parseDouble(number) : Long.parseLong(number);
        }

        private boolean peek(char expected) {
            return position < text.length() && text.charAt(position) == expected;
        }

        private void expect(char expected) {
            if (!peek(expected)) {
                throw new IllegalArgumentException("Expected '" + expected + "' at " + position);
            }
            position++;
        }
    }
}
