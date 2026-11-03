package cn.hmremote.bridge;

interface HosAdapter {
    record Config(
            String serial,
            String hdcPath,
            String hdcPort,
            int scale,
            int frameRate,
            int bitRate,
            int iFrameInterval) {}

    interface Listener {
        void onVideo(byte[] data);

        void onReady(int width, int height);

        void onError(Throwable error);
    }

    void start(Listener listener) throws Exception;

    void stop() throws Exception;

    void touch(String phase, int x, int y) throws Exception;

    void wheel(String direction, int x, int y) throws Exception;

    void key(String key) throws Exception;

    void keyboard(String keys) throws Exception;

    void rotate(String orientation) throws Exception;

    void paste(String text) throws Exception;

    void requestIdr() throws Exception;
}
