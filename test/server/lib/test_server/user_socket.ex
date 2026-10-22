defmodule TestServer.UserSocket do
  @moduledoc """
  Tokens: none connects as anonymous, `user:<name>` connects as that user,
  anything else is refused (HTTP 403, the usual answer to a bad token). Every
  connect attempt is recorded with the token and how it was sent.
  """
  use Phoenix.Socket

  channel "__absinthe__:*", TestServer.ControlChannel,
    assigns: %{
      __absinthe_schema__: TestServer.Schema,
      __absinthe_pipeline__: {TestServer.Pipeline, :pipeline},
      __absinthe_gc_interval__: nil
    }

  @impl true
  def connect(params, socket, connect_info) do
    {token, via} = token_of(params, connect_info)
    TestServer.State.record_connect(%{token: token, via: via})

    case user_of(token) do
      {:ok, user} ->
        options = [context: %{current_user: user}]
        socket = socket |> assign(:user, user) |> Absinthe.Phoenix.Socket.put_options(options)
        {:ok, socket}

      :error ->
        :error
    end
  end

  @impl true
  def id(socket), do: "user_socket:#{socket.assigns.user || "anonymous"}"

  defp token_of(params, connect_info) do
    cond do
      is_binary(connect_info[:auth_token]) -> {connect_info.auth_token, "auth_token"}
      is_binary(params["token"]) -> {params["token"], "params"}
      true -> {nil, "none"}
    end
  end

  defp user_of(nil), do: {:ok, nil}
  defp user_of("user:" <> user) when user != "", do: {:ok, user}
  defp user_of(_token), do: :error
end
