// Runs the LivePictures conformance suite against the engine's implementation.
import { runLivePicturesConformance } from "../../contracts/conformance/live-pictures";
import { EngineLivePictures } from "../live-pictures";

runLivePicturesConformance((...args) => new EngineLivePictures(...args));
