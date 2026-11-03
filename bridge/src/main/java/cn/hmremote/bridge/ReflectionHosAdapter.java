package cn.hmremote.bridge;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Map;

final class ReflectionHosAdapter implements HosAdapter {
    private final Object device;
    private final Class<?> deviceClass;
    private volatile Listener listener;
    private volatile int screenWidth;
    private volatile int screenHeight;
    private boolean wheelTouchActive;
    private int wheelTouchX;
    private int wheelTouchY;

    ReflectionHosAdapter(Config config) throws Exception {
        Class<?> configClass = Class.forName("com.huawei.hosscrcpy.api.HosRemoteConfig");
        Object remoteConfig = configClass.getConstructor(String.class).newInstance(config.serial());
        invoke(configClass, remoteConfig, "setHdcPath", String.class, config.hdcPath());
        invoke(configClass, remoteConfig, "setHdcPort", String.class, config.hdcPort());
        invoke(configClass, remoteConfig, "setScale", int.class, config.scale());
        invoke(configClass, remoteConfig, "setFrameRate", int.class, config.frameRate());
        invoke(configClass, remoteConfig, "setBitRate", int.class, config.bitRate());
        invoke(configClass, remoteConfig, "setIFrameInterval", int.class, config.iFrameInterval());
        deviceClass = Class.forName("com.huawei.hosscrcpy.api.HosRemoteDevice");
        Constructor<?> constructor = deviceClass.getConstructor(configClass);
        device = constructor.newInstance(remoteConfig);
    }

    @Override
    public void start(Listener listener) throws Exception {
        this.listener = listener;
        Class<?> callbackClass = Class.forName("com.huawei.hosscrcpy.api.ScreenCapCallback");
        Object callback = Proxy.newProxyInstance(
                callbackClass.getClassLoader(),
                new Class<?>[] { callbackClass },
                (proxy, method, arguments) -> {
                    switch (method.getName()) {
                        case "onData" -> onData((ByteBuffer) arguments[0]);
                        case "onReady" -> onReady();
                        case "onException" -> listener.onError((Throwable) arguments[0]);
                        case "toString" -> {
                            return "HmRemoteScreenCapCallback";
                        }
                        default -> {
                            return null;
                        }
                    }
                    return null;
                });
        invoke(deviceClass, device, "startCaptureScreen", callbackClass, callback);
    }

    @Override
    public synchronized void stop() throws Exception {
        finishWheelTouch();
        invokeNoArgs("stopCaptureScreen");
    }

    @Override
    public synchronized void touch(String phase, int x, int y) throws Exception {
        finishWheelTouch();
        String method = switch (phase) {
            case "down" -> "onTouchDown";
            case "move" -> "onTouchMove";
            case "up" -> "onTouchUp";
            default -> throw new IllegalArgumentException("Unknown touch phase");
        };
        sendTouch(method, x, y);
    }

    @Override
    public synchronized void wheel(String direction, int x, int y) throws Exception {
        if ("stop".equals(direction)) {
            finishWheelTouch();
            return;
        }
        if (!"up".equals(direction) && !"down".equals(direction)) {
            throw new IllegalArgumentException("Unknown wheel direction");
        }

        int maximumX = Math.max(0, screenWidth - 1);
        int maximumY = Math.max(0, screenHeight - 1);
        int startX = clamp(x, 0, maximumX);
        int startY = clamp(y, 0, maximumY);
        if (!wheelTouchActive) {
            wheelTouchX = startX;
            wheelTouchY = startY;
            sendTouch("onTouchDown", wheelTouchX, wheelTouchY);
            wheelTouchActive = true;
        }

        int step = Math.max(24, Math.max(1, screenHeight) / 30);
        int nextY = clamp(
                wheelTouchY + ("up".equals(direction) ? step : -step),
                0,
                maximumY);
        if (nextY == wheelTouchY) {
            finishWheelTouch();
            wheelTouchX = startX;
            wheelTouchY = startY;
            sendTouch("onTouchDown", wheelTouchX, wheelTouchY);
            wheelTouchActive = true;
            nextY = clamp(
                    wheelTouchY + ("up".equals(direction) ? step : -step),
                    0,
                    maximumY);
        }
        wheelTouchX = startX;
        wheelTouchY = nextY;
        sendTouch("onTouchMove", wheelTouchX, wheelTouchY);
    }

    @Override
    public void key(String key) throws Exception {
        String value = switch (key) {
            case "Back" -> "Back";
            case "Home" -> "Home";
            case "Power" -> "Power";
            case "VolumeUp" -> "16";
            case "VolumeDown" -> "17";
            default -> throw new IllegalArgumentException("Unsupported key");
        };
        shell("uitest uiInput keyEvent " + value, 5_000);
    }

    @Override
    public void keyboard(String keys) throws Exception {
        if (!keys.matches("[0-9]{1,4}( [0-9]{1,4}){0,2}")) {
            throw new IllegalArgumentException("Invalid keyboard keys");
        }
        shell("uitest uiInput keyEvent " + keys, 5_000);
    }

    @Override
    public void rotate(String orientation) throws Exception {
        invokeNoArgs("horizontal".equals(orientation) ? "setRotationHorizontal" : "setRotationVertical");
    }

    @Override
    public void paste(String text) throws Exception {
        if (text.indexOf('\0') >= 0 || text.getBytes(StandardCharsets.UTF_8).length > 1024 * 1024) {
            throw new IllegalArgumentException("Invalid paste text");
        }
        shell("uitest uiInput text " + quoteShell(text), 15_000);
    }

    @Override
    public void requestIdr() throws Exception {
        invokeNoArgs("requestIDRFrame");
    }

    private void onData(ByteBuffer source) {
        ByteBuffer data = source.duplicate();
        byte[] bytes = new byte[data.remaining()];
        data.get(bytes);
        Listener current = listener;
        if (current != null && bytes.length > 0) {
            current.onVideo(bytes);
        }
    }

    private void onReady() {
        try {
            Object size = deviceClass.getMethod("getScreenSize", boolean.class).invoke(device, false);
            Field width = size.getClass().getField("width");
            Field height = size.getClass().getField("height");
            screenWidth = width.getInt(size);
            screenHeight = height.getInt(size);
            listener.onReady(screenWidth, screenHeight);
        } catch (Throwable error) {
            listener.onError(unwrap(error));
            return;
        }

        try {
            // Request a codec keyframe without creating a system mouse device.
            // The desktop supplies a screenshot placeholder if the SDK still
            // has no frame while the phone image is completely static.
            invokeNoArgs("requestIDRFrame");
        } catch (Throwable error) {
            Throwable cause = unwrap(error);
            String message = cause.getMessage() == null
                    ? cause.getClass().getSimpleName()
                    : cause.getMessage();
            System.err.println("Unable to request first video frame: " + message);
        }
    }

    private void sendTouch(String method, int x, int y) throws Exception {
        Method target = deviceClass.getMethod(method, int.class, int.class);
        target.invoke(device, x, y);
    }

    private void finishWheelTouch() throws Exception {
        if (!wheelTouchActive) {
            return;
        }
        try {
            sendTouch("onTouchUp", wheelTouchX, wheelTouchY);
        } finally {
            wheelTouchActive = false;
        }
    }

    private static int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    private String shell(String command, int timeout) throws Exception {
        try {
            Object output = deviceClass.getMethod("executeShellCommand", String.class, int.class)
                    .invoke(device, command, timeout);
            return String.valueOf(output);
        } catch (InvocationTargetException error) {
            throw asException(error.getTargetException());
        }
    }

    private void invokeNoArgs(String method) throws Exception {
        try {
            deviceClass.getMethod(method).invoke(device);
        } catch (InvocationTargetException error) {
            throw asException(error.getTargetException());
        }
    }

    private static void invoke(
            Class<?> type,
            Object target,
            String name,
            Class<?> parameterType,
            Object argument) throws Exception {
        type.getMethod(name, parameterType).invoke(target, argument);
    }

    private static String quoteShell(String value) {
        return "'" + value.replace("'", "'\\''").replace("\r\n", "\n").replace('\r', '\n') + "'";
    }

    private static Throwable unwrap(Throwable error) {
        return error instanceof InvocationTargetException invocation && invocation.getTargetException() != null
                ? invocation.getTargetException()
                : error;
    }

    private static Exception asException(Throwable error) {
        return error instanceof Exception exception ? exception : new Exception(error);
    }
}
