class ExtractorRegistry {
  constructor() {

    this._extractors = [];
    if (typeof YouTubeExtractor !== "undefined")
      this._extractors.push({ cls: YouTubeExtractor, name: "YouTube" });
    if (typeof TwitterExtractor !== "undefined")
      this._extractors.push({ cls: TwitterExtractor, name: "Twitter" });
    if (typeof InstagramExtractor !== "undefined")
      this._extractors.push({ cls: InstagramExtractor, name: "Instagram" });
    if (typeof MXPlayerExtractor !== "undefined")
      this._extractors.push({ cls: MXPlayerExtractor, name: "MX Player" });
    if (typeof BaahiExtractor !== "undefined")
      this._extractors.push({ cls: BaahiExtractor, name: "Baahi Music" });
    if (typeof LersiaPlayExtractor !== "undefined")
      this._extractors.push({ cls: LersiaPlayExtractor, name: "LersiaPlay" });
    if (typeof NortheastNewsExtractor !== "undefined")
      this._extractors.push({
        cls: NortheastNewsExtractor,
        name: "Northeast News",
      });
    if (typeof EastMojoExtractor !== "undefined")
      this._extractors.push({ cls: EastMojoExtractor, name: "EastMojo" });

    if (typeof GenericExtractor !== "undefined")
      this._extractors.push({ cls: GenericExtractor, name: "Generic" });

    this._activeExtractor = null;
    this._currentUrl = null;
  }

  getExtractor(url) {
    for (const entry of this._extractors) {
      try {
        if (entry.cls.canHandle(url)) {
          console.log(
            `[Registry] Matched: ${entry.name} for ${url.substring(0, 80)}`,
          );
          return new entry.cls();
        }
      } catch (e) {
        console.warn(`[Registry] Error checking ${entry.name}:`, e.message);
      }
    }
    return null;
  }

  async activate(url) {

    const normalizeUrl = (u) => {
      try {
        const parsed = new URL(u);
        return parsed.origin + parsed.pathname;
      } catch {
        return u;
      }
    };
    if (
      this._activeExtractor &&
      normalizeUrl(this._currentUrl) === normalizeUrl(url)
    ) {
      return this._activeExtractor;
    }

    const extractor = this.getExtractor(url);
    if (!extractor) {
      console.log("[Registry] No extractor matched for:", url.substring(0, 80));
      this._deactivate();
      return null;
    }

    if (
      this._activeExtractor &&
      this._activeExtractor.name !== extractor.name
    ) {
      console.log(
        `[Registry] Switching from ${this._activeExtractor.name} to ${extractor.name}`,
      );
      this._deactivate();
    }

    if (
      this._activeExtractor &&
      this._activeExtractor.name === extractor.name
    ) {
      this._currentUrl = url;
      return this._activeExtractor;
    }

    try {
      await extractor.init();
      this._activeExtractor = extractor;
      this._currentUrl = url;
      console.log(`[Registry] Activated: ${extractor.name}`);
      return extractor;
    } catch (e) {
      console.error(`[Registry] Failed to init ${extractor.name}:`, e);
      return null;
    }
  }

  _deactivate() {
    if (this._activeExtractor) {
      try {
        this._activeExtractor.destroy();
      } catch (e) {}
      this._activeExtractor = null;
      this._currentUrl = null;
    }
  }

  get active() {
    return this._activeExtractor;
  }

  listExtractors() {
    return this._extractors.map((e) => e.name);
  }

  canHandle(url) {
    return this._extractors.some((e) => {
      try {
        return e.cls.canHandle(url);
      } catch {
        return false;
      }
    });
  }

  destroy() {
    this._deactivate();
    console.log("[Registry] Destroyed");
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.ExtractorRegistry = ExtractorRegistry;
}
