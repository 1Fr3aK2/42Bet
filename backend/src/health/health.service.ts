import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createClient } from 'redis';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as https from 'https';
import * as fs from 'fs';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
  ) { }

  async checkDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async checkRedis(): Promise<boolean> {
    const client = createClient({
      url: process.env.REDIS_URL,
    });

    try {
      await client.connect();
      const pong = await client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    } finally {
      if (client.isOpen) {
        await client.disconnect();
      }
    }
  }

  async checkVault(): Promise<boolean> {
    try {
      const httpsAgent = new https.Agent({
        ca: fs.readFileSync(process.env.VAULT_CACERT),
      });

      await firstValueFrom(
        this.http.get(`${process.env.VAULT_ADDR}/v1/sys/health`, {
          httpsAgent,
        }),
      );

      return true;
    } catch {
      return false;
    }
  }

  async checkElasticsearch(): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.get('http://elasticsearch:9200/_cluster/health', {
          auth: {
            username: 'elastic',
            password: process.env.ELASTIC_PASSWORD,
          },
          timeout: 3000,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}