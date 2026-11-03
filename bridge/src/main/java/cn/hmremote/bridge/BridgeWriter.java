package cn.hmremote.bridge;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

final class BridgeWriter {
    static final int TYPE_VIDEO = 1;
    static final int TYPE_JSON = 2;
    static final int FLAG_IDR = 1;
    static final int FLAG_CONFIG = 2;

    private final OutputStream output;
    private final AtomicInteger sequence = new AtomicInteger();
    private long statsStartedNs = System.nanoTime();
    private long statsBytes;
    private long statsFrames;

    BridgeWriter(OutputStream output) {
        this.output = output;
    }

    synchronized void video(byte[] data) throws IOException {
        int flags = detectH264Flags(data);
        writeFrame(TYPE_VIDEO, flags, data, System.nanoTime() / 1_000L);
        statsBytes += data.length;
        statsFrames++;
        long now = System.nanoTime();
        long elapsed = now - statsStartedNs;
        if (elapsed >= 1_000_000_000L) {
            double seconds = elapsed / 1_000_000_000.0;
            Map<String, Object> stats = new LinkedHashMap<>();
            stats.put("type", "event");
            stats.put("event", "stats");
            stats.put("fps", Math.round(statsFrames / seconds));
            stats.put("bitrate", Math.round(statsBytes * 8 / seconds));
            json(stats);
            statsStartedNs = now;
            statsBytes = 0;
            statsFrames = 0;
        }
    }

    synchronized void response(long id, boolean ok, String error) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("type", "response");
        response.put("id", id);
        response.put("ok", ok);
        if (error != null && !error.isBlank()) {
            response.put("error", error);
        }
        json(response);
    }

    synchronized void event(String name, Map<String, ?> values) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "event");
        event.put("event", name);
        event.putAll(values);
        json(event);
    }

    private void json(Map<String, ?> value) {
        try {
            writeFrame(TYPE_JSON, 0, MiniJson.stringify(value).getBytes(StandardCharsets.UTF_8),
                    System.nanoTime() / 1_000L);
        } catch (IOException error) {
            throw new IllegalStateException("Unable to write bridge response", error);
        }
    }

    private void writeFrame(int type, int flags, byte[] payload, long timestampUs) throws IOException {
        ByteBuffer header = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN);
        header.put((byte) 'H').put((byte) 'M').put((byte) 'R').put((byte) '1');
        header.put((byte) 1);
        header.put((byte) type);
        header.putShort((short) flags);
        header.putInt(payload.length);
        header.putInt(sequence.getAndIncrement());
        header.putLong(timestampUs);
        output.write(header.array());
        output.write(payload);
        output.flush();
    }

    private int detectH264Flags(byte[] data) {
        int flags = 0;
        for (int index = 0; index + 4 < data.length; index++) {
            int startCodeLength = data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1
                    ? 3
                    : data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 0
                            && data[index + 3] == 1 ? 4 : 0;
            if (startCodeLength == 0 || index + startCodeLength >= data.length) {
                continue;
            }
            int nalType = data[index + startCodeLength] & 0x1f;
            if (nalType == 5) {
                flags |= FLAG_IDR;
            } else if (nalType == 7 || nalType == 8) {
                flags |= FLAG_CONFIG;
            }
        }
        return flags;
    }
}
