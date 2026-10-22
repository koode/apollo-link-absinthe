defmodule TestServer.StdinWatcher do
  @moduledoc """
  Stops the VM when stdin closes, so the server never outlives the test run
  that started it, even when that run is killed.
  """
  use Task, restart: :permanent

  def start_link(_options), do: Task.start_link(&watch/0)

  defp watch do
    case IO.read(:stdio, :line) do
      :eof -> System.halt(0)
      {:error, _reason} -> System.halt(0)
      _line -> watch()
    end
  end
end
