/** Bundles site favicons locally to avoid requests to third-party services. */
import beepbox from "./beepbox.ico" with { type: "file" };
import freeAssets from "./free-game-dev-assets.svg" with { type: "file" };
import freesound from "./freesound.png" with { type: "file" };
import gameIcons from "./game-icons.ico" with { type: "file" };
import itch from "./itch.ico" with { type: "file" };
import kenney from "./kenney.ico" with { type: "file" };
import openGameArt from "./opengameart.ico" with { type: "file" };
import polyHaven from "./poly-haven.ico" with { type: "file" };

const siteIcons: Record<string, string> = {
    "kenney": kenney,
    "kaykit": itch,
    "poly-haven": polyHaven,
    "itch-io-cc0-16-16": itch,
    "opengameart-textures": openGameArt,
    "abstraction-music-loops": itch,
    "beepbox": beepbox,
    "freesound": freesound,
    "game-icons-net": gameIcons,
    "free-game-dev-assets": freeAssets,
};

export default siteIcons;
