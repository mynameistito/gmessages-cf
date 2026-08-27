import { Container } from "@cloudflare/containers";

/** Cloudflare Durable Object host for the isolated Go adapter container. */
export class GoogleMessagesContainer extends Container {
  override defaultPort = 8787;
}
