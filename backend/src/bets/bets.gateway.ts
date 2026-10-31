import { JwtService } from '@nestjs/jwt';
import { OnEvent } from '@nestjs/event-emitter';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';

// Real-time channel of the betting engine: the Socket.IO namespace "/bets".
// The browser connects with its login token ({ auth: { token } }); the gateway
// checks it and puts the socket in a room of its own user, so each user only
// hears about their own bets.
@WebSocketGateway({ namespace: '/bets', cors: { origin: '*' } })
export class BetsGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Namespace;

  constructor(private readonly jwt: JwtService) {}

  handleConnection(client: Socket) {
    try {
      const payload = this.jwt.verify(client.handshake.auth?.token, {
        secret: process.env.JWT_SECRET,
      });
      client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect(true); // missing, invalid or expired token
    }
  }

  // Emitted by BetsService when one of the user's bets is placed or settled.
  @OnEvent('bets.changed')
  notify({ userId }: { userId: number }) {
    this.server.to(`user:${userId}`).emit('bets:changed');
  }
}
