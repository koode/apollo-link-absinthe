defmodule TestServer.Pipeline do
  @moduledoc "The channel's default pipeline with `TestServer.Phase.SubscribeSelf`."

  def pipeline(schema, options) do
    schema
    |> Absinthe.Phoenix.Channel.default_pipeline(options)
    |> Absinthe.Pipeline.replace(
      Absinthe.Phase.Subscription.SubscribeSelf,
      TestServer.Phase.SubscribeSelf
    )
  end
end
