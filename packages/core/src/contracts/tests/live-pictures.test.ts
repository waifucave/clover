// Runs the LivePictures conformance suite against FakeLivePictures.
import { runLivePicturesConformance } from "../conformance/live-pictures";
import { FakeLivePictures } from "../fakes/live-pictures";

runLivePicturesConformance((...args) => new FakeLivePictures(...args));
