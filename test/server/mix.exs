defmodule TestServer.MixProject do
  use Mix.Project

  def project do
    [
      app: :test_server,
      version: "0.1.0",
      elixir: "~> 1.15",
      start_permanent: false,
      deps: deps()
    ]
  end

  def application do
    [mod: {TestServer.Application, []}, extra_applications: [:logger]]
  end

  # A production app's versions. PHOENIX_VERSION and friends let CI try newer ones.
  defp deps do
    [
      {:phoenix, System.get_env("PHOENIX_VERSION", "1.8.8")},
      {:phoenix_pubsub, "2.2.0"},
      {:absinthe, System.get_env("ABSINTHE_VERSION", "1.11.0")},
      {:absinthe_phoenix, System.get_env("ABSINTHE_PHOENIX_VERSION", "2.0.5")},
      {:plug_cowboy, "2.9.0"},
      {:jason, "1.4.5"}
    ]
  end
end
