import "@isomorphic-git/lightning-fs";
import "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Buffer } from "buffer";

export async function cloneOrFetchRepo({
  git,
  fs,
  http,
  dir,
  url,
  branch,
  depth,
}) {
  try {
    await git.clone({
      fs,
      http,
      dir,
      url,
      ref: branch,
      singleBranch: true,
      depth,
      corsProxy: "https://cors.isomorphic-git.org", // used in browser, ignored in Node
    });
  } catch {
    await git.fetch({
      fs,
      http,
      dir,
      url,
      ref: branch,
      singleBranch: true,
      depth,
      corsProxy: "https://cors.isomorphic-git.org",
    });
  }
}

export async function getCommits({ git, fs, dir, branch, depth }) {
  return await git.log({ fs, dir, ref: branch, depth });
}

export async function checkoutCommit({ git, fs, dir, oid }) {
  await git.checkout({ fs, dir, ref: oid, force: true });
}

export async function readIndexFile({ fs, pfs, dir }) {
  // pfs is fs.promises (Node) or LightningFS.promises (browser)
  const file = await pfs.readFile(`${dir}/index.html`, "utf8");

  return file;
}

export class NewsSummaryBrowser extends HTMLElement {
  #connected = false;

  static get observedAttributes() {
    return [
      "repo-url",
      "branch",
      "initial-depth",
      "fetch-threshold",
      "fetch-step",
    ];
  }

  constructor() {
    super();

    if (!globalThis.Buffer) {
      globalThis.Buffer = Buffer;
    }

    let shadow = this.shadowRoot;
    if (!shadow) {
      const template = this.querySelector("template[shadowrootmode]");
      if (template) {
        shadow = this.attachShadow({
          mode: template.getAttribute("shadowrootmode") || "open",
        });

        shadow.appendChild(template.content.cloneNode(true));

        template.remove();
      }
    }

    if (shadow && "adoptedStyleSheets" in shadow) {
      Promise.all([
        fetch("./components/news-summary-browser.css").then((r) => r.text()),
      ])
      .then(([componentCSS]) => {
          const componentSheet = new CSSStyleSheet();
          componentSheet.replace(componentCSS);

          shadow.adoptedStyleSheets = [componentSheet];
        })
        .catch(console.error);

    }

    this.shadow = shadow;

    this.currentIndex = 0;
    this.fetchFailed = false;
    this.isFetching = false;
    this.loadingMore = false;
    this.log = [];

    this.branch = this.getAttribute("branch") || "main";
    this.fetchStep = parseInt(this.getAttribute("fetch-step")) || 10;
    this.fetchThreshold = parseInt(this.getAttribute("fetch-threshold")) || 2;
    this.initialDepth = parseInt(this.getAttribute("initial-depth")) || 10;
    this.repoUrl =
      this.getAttribute("repo-url") ||
      "https://github.com/kherrick/news-summary";
  }

  adoptedCallback() {
    this.connectedCallback();
  }

  disconnectedCallback() {
    this.backBtn?.removeEventListener("click", this.showOlderHandler);
    this.nextBtn?.removeEventListener("click", this.showNewerHandler);

    if (this.abortController) {
      this.abortController.abort();
    }
  }

  connectedCallback() {
    if (this.#connected) {
      return;
    }

    this.#connected = true;

    this.showOlderHandler = () => this.showOlder();
    this.showNewerHandler = () => this.showNewer();

    this.backBtn = this.shadow?.querySelector("#backBtn");
    this.nextBtn = this.shadow?.querySelector("#nextBtn");
    this.commitInfo = this.shadow?.querySelector("#commitInfo");
    this.status = this.shadow?.querySelector("#status");
    this.content = this.shadow?.querySelector("#content");

    if (!this.shadow || !this.content) {
      console.error("Shadow DOM or #content not found");

      return;
    }

    this.backBtn?.addEventListener("click", this.showOlderHandler);
    this.nextBtn?.addEventListener("click", this.showNewerHandler);

    this.initializeRepo();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) {
      return;
    }

    const propName = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    this[propName] = parseInt(newValue) || newValue;
  }

  updateStatus(msg) {
    this.status && (this.status.textContent = msg);
  }

  async prefetchMore() {
    if (this.isFetching || this.fetchFailed || this.loadingMore) {
      return;
    }

    this.isFetching = this.loadingMore = true;
    const { fs, dir } = globalThis;
    const targetDepth = this.log.length + this.fetchStep;

    this.updateStatus(
      `Fetching ${this.fetchStep} more commits... (${targetDepth} total)`
    );

    try {
      await git.fetch({
        fs,
        http,
        dir,
        url: this.repoUrl,
        ref: this.branch,
        singleBranch: true,
        depth: targetDepth,
        shallow: true,
        corsProxy: "https://cors.isomorphic-git.org",
      });

      this.log = await git.log({
        fs,
        dir,
        ref: this.branch,
        depth: targetDepth,
      });

      this.fetchFailed = false;
    } catch {
      this.fetchFailed = true;
    } finally {
      this.isFetching = this.loadingMore = false;

      this.updateStatus(this.fetchFailed ? "Reached oldest commit" : "");

      this.updateUI();
    }
  }

  updateUI() {
    if (this.log[this.currentIndex]) {
      const commit = this.log[this.currentIndex];

      this.commitInfo.textContent = `Commit ${this.currentIndex + 1}/${
        this.log.length
      }: ${commit.commit.message.trim().split("\n")[0]}`;
    }

    if (this.backBtn && this.nextBtn) {
      this.backBtn.disabled =
        this.currentIndex >= this.log.length - 1 &&
        (this.fetchFailed || !this.loadingMore);

      this.nextBtn.disabled = this.currentIndex <= 0;

      this.backBtn.textContent = this.loadingMore
        ? "⬅ Loading older..."
        : "⬅ Back (Older)";
    }
  }

  async showOlder() {
    const remaining = this.log.length - this.currentIndex - 1;
    if (
      remaining <= this.fetchThreshold &&
      !this.fetchFailed &&
      !this.loadingMore
    ) {
      await this.prefetchMore();
    }

    if (this.currentIndex < this.log.length - 1) {
      this.currentIndex++;

      await this.displayCommit(this.currentIndex);
    }
  }

  async showNewer() {
    if (this.currentIndex > 0) {
      this.currentIndex--;

      await this.displayCommit(this.currentIndex);
    }
  }

  async initializeRepo() {
    const fs = (globalThis.fs ??= new LightningFS("fs"));
    const pfs = (globalThis.pfs ??= fs.promises);
    globalThis.dir = "/repo";

    try {
      await pfs.mkdir("/repo");
    } catch {}

    this.updateStatus(`Loading ${this.initialDepth} commits...`);

    await cloneOrFetchRepo({
      git,
      fs,
      http,
      dir: "/repo",
      url: this.repoUrl,
      branch: this.branch,
      depth: this.initialDepth,
    });

    await git.checkout({ fs, dir: "/repo", ref: `origin/${this.branch}` });

    this.log = await getCommits({
      git,
      fs,
      dir: "/repo",
      branch: `origin/${this.branch}`,
      depth: this.initialDepth,
    });

    this.updateStatus("");
    this.shadowRoot.querySelector(".news-browser__content").style.animation =
      "none";

    await this.displayCommit(0);
  }

  async displayCommit(index) {
    if (index < 0 || index >= this.log.length) {
      return;
    }

    const { fs, pfs, dir } = globalThis;
    const commit = this.log[index];
    this.currentIndex = index;

    await checkoutCommit({ git, fs, dir, oid: commit.oid });

    try {
      const file = await readIndexFile({ fs, pfs, dir });

      const doc = document.implementation.createHTMLDocument();
      doc.documentElement.innerHTML = file;

      const hr = doc.body.querySelector("hr");
      if (hr) {
        while (hr.nextSibling) {
          hr.parentNode.removeChild(hr.nextSibling);
        }
      }

      this.content.innerHTML = doc.body.innerHTML;
    } catch {
      this.content.innerHTML = "<em>No index.html found in commit</em>";
    }

    this.updateUI();
  }
}
