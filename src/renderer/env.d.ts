declare class MediaStreamTrackProcessor<T extends VideoFrame | AudioData = VideoFrame> {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<T>;
}
