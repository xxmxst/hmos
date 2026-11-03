package cn.hmremote.bridge;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

public final class BridgeMain {
    private final BridgeWriter writer;
    private HosAdapter adapter;

    private BridgeMain(BridgeWriter writer) {
        this.writer = writer;
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 1 && "--check-runtime".equals(args[0])) {
            checkRuntime();
            System.out.println("HOScrcpy runtime dependencies are ready.");
            return;
        }
        PrintStream protocolOutput = System.out;
        System.setOut(System.err);
        BridgeMain bridge = new BridgeMain(new BridgeWriter(protocolOutput));
        bridge.writer.event("bridgeReady", Map.of("protocol", 1));
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.isBlank()) {
                    bridge.handle(line);
                }
            }
        } finally {
            bridge.stopQuietly();
        }
    }

    private void handle(String line) {
        long id = 0;
        try {
            Map<String, Object> command = MiniJson.parseObject(line);
            id = number(command, "id");
            String name = string(command, "command");
            switch (name) {
                case "start" -> start(command);
                case "stop" -> stop();
                case "touch" -> requireAdapter().touch(
                        string(command, "phase"), integer(command, "x"), integer(command, "y"));
                case "wheel" -> requireAdapter().wheel(
                        string(command, "direction"), integer(command, "x"), integer(command, "y"));
                case "key" -> requireAdapter().key(string(command, "key"));
                case "keyboard" -> requireAdapter().keyboard(string(command, "keys"));
                case "rotate" -> requireAdapter().rotate(string(command, "orientation"));
                case "paste" -> requireAdapter().paste(string(command, "text"));
                case "requestIdr" -> requireAdapter().requestIdr();
                case "ping" -> {
                    // No-op.
                }
                default -> throw new IllegalArgumentException("Unknown command: " + name);
            }
            writer.response(id, true, null);
        } catch (Throwable error) {
            Throwable cause = rootCause(error);
            String message = cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage();
            System.err.println("Bridge command failed: " + cause.getClass().getName() + ": " + message);
            error.printStackTrace(System.err);
            writer.response(id, false, safeMessage(cause.getClass().getSimpleName() + ": " + message));
        }
    }

    private static void checkRuntime() throws ClassNotFoundException {
        Class.forName("java.sql.Date");
        Class.forName("sun.misc.Unsafe");
        Class.forName("com.alibaba.fastjson.JSONObject");
        Class.forName("com.alibaba.fastjson2.JSONFactory");
    }

    private static Throwable rootCause(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        return current;
    }

    private void start(Map<String, Object> command) throws Exception {
        stopQuietly();
        HosAdapter.Config config = new HosAdapter.Config(
                string(command, "serial"),
                string(command, "hdcPath"),
                string(command, "hdcPort"),
                integer(command, "scale"),
                integer(command, "frameRate"),
                integer(command, "bitRate"),
                integer(command, "iFrameInterval"));
        adapter = new ReflectionHosAdapter(config);
        adapter.start(new HosAdapter.Listener() {
            @Override
            public void onVideo(byte[] data) {
                try {
                    writer.video(data);
                } catch (Exception error) {
                    onError(error);
                }
            }

            @Override
            public void onReady(int width, int height) {
                Map<String, Object> values = new LinkedHashMap<>();
                values.put("width", width);
                values.put("height", height);
                writer.event("ready", values);
            }

            @Override
            public void onError(Throwable error) {
                Map<String, Object> values = new LinkedHashMap<>();
                String message = error.getMessage() == null
                        ? error.getClass().getSimpleName()
                        : error.getMessage();
                String code = captureErrorCode(error);
                values.put("message", safeMessage(message));
                values.put("errorClass", error.getClass().getName());
                if (code != null) {
                    values.put("code", code);
                }
                values.put("recoverable", isRecoverableCaptureError(error));
                writer.event("error", values);
            }
        });
    }

    private void stop() throws Exception {
        if (adapter != null) {
            HosAdapter current = adapter;
            adapter = null;
            current.stop();
        }
    }

    private void stopQuietly() {
        try {
            stop();
        } catch (Exception error) {
            System.err.println("Unable to stop capture: " + safeMessage(error.getMessage()));
        }
    }

    private HosAdapter requireAdapter() {
        if (adapter == null) {
            throw new IllegalStateException("Capture is not running");
        }
        return adapter;
    }

    private static String string(Map<String, Object> object, String key) {
        Object value = object.get(key);
        if (!(value instanceof String string)) {
            throw new IllegalArgumentException("Missing string: " + key);
        }
        return string;
    }

    private static int integer(Map<String, Object> object, String key) {
        long value = number(object, key);
        if (value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Integer out of range: " + key);
        }
        return (int) value;
    }

    private static long number(Map<String, Object> object, String key) {
        Object value = object.get(key);
        if (!(value instanceof Number number)) {
            throw new IllegalArgumentException("Missing number: " + key);
        }
        return number.longValue();
    }

    private static String safeMessage(String message) {
        if (message == null) {
            return "Unknown error";
        }
        String sanitized = message.replaceAll("[\\r\\n]+", " ")
                .replaceAll("[A-Za-z0-9]{16,}", "[redacted]");
        return sanitized.substring(0, Math.min(400, sanitized.length()));
    }

    private static boolean isRecoverableCaptureError(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String details = (current.getClass().getName() + " " + current.getMessage()).toUpperCase();
            if (details.contains("UNAVAILABLE")
                    && (details.contains("IO EXCEPTION")
                            || details.contains("CONNECTION")
                            || details.contains("CHANNEL")
                            || details.contains("TRANSPORT"))) {
                return true;
            }
        }
        return false;
    }

    private static String captureErrorCode(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String details = (current.getClass().getName() + " " + current.getMessage()).toUpperCase();
            if (details.contains("UNAVAILABLE")) {
                return "UNAVAILABLE";
            }
        }
        return null;
    }
}
