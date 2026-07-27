class Jinn < Formula
  desc "Lightweight AI gateway daemon orchestrating Claude Code and Codex"
  homepage "https://github.com/hristo2612/jinn"
  url "https://registry.npmjs.org/jinn-cli/-/jinn-cli-0.28.7.tgz"
  sha256 "e262f5fb18827e8d4c05491396e2ccd45e9d320e03ff86e90c29aaeb1719d7d2"
  license "MIT"

  livecheck do
    url "https://registry.npmjs.org/jinn-cli"
    regex(/"latest":\s*"(\d+(?:\.\d+)+)"/)
  end

  depends_on "node@22"
  depends_on "python" => :build

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      To get started, run:
        jinn setup

      Then start the gateway daemon:
        jinn start

      The web dashboard will be available at http://localhost:7777
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/jinn --version")
    assert_match "Usage", shell_output("#{bin}/jinn --help")

    cd libexec/"lib/node_modules/jinn-cli" do
      system "node", "-e", "require('better-sqlite3')"
      system "node", "-e", "require('classic-level')"
    end
  end
end
