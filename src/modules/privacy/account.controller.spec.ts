import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ALLOW_DEACTIVATED_KEY } from '../../common/decorators/allow-deactivated.decorator';

describe('AccountController', () => {
  let app: INestApplication;
  const service = {
    deactivate: jest.fn(),
    reactivate: jest.fn(),
    deleteAccount: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountController],
      providers: [{ provide: AccountService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { id: 'user-1' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(() => app.close());

  it('POST /privacy/account/deactivate requires the DEACTIVATE confirmation', async () => {
    await request(app.getHttpServer()).post('/privacy/account/deactivate').send({}).expect(400);
    await request(app.getHttpServer())
      .post('/privacy/account/deactivate')
      .send({ confirmation: 'yes' })
      .expect(400);
    expect(service.deactivate).not.toHaveBeenCalled();
  });

  it('POST /privacy/account/deactivate deactivates the JWT user', async () => {
    service.deactivate.mockResolvedValue({ deactivated: true });
    await request(app.getHttpServer())
      .post('/privacy/account/deactivate')
      .send({ confirmation: 'DEACTIVATE' })
      .expect(200, { deactivated: true });
    expect(service.deactivate).toHaveBeenCalledWith('user-1');
  });

  it('POST /privacy/account/reactivate needs no body', async () => {
    service.reactivate.mockResolvedValue({ reactivated: true });
    await request(app.getHttpServer())
      .post('/privacy/account/reactivate')
      .expect(200, { reactivated: true });
    expect(service.reactivate).toHaveBeenCalledWith('user-1');
  });

  it('DELETE /privacy/account refuses without the DELETE confirmation', async () => {
    await request(app.getHttpServer()).delete('/privacy/account').expect(400);
    await request(app.getHttpServer())
      .delete('/privacy/account')
      .send({ confirmation: 'delete' })
      .expect(400);
    expect(service.deleteAccount).not.toHaveBeenCalled();
  });

  it('DELETE /privacy/account deletes the JWT user, ignoring any id in the body', async () => {
    service.deleteAccount.mockResolvedValue({ deleted: true });
    await request(app.getHttpServer())
      .delete('/privacy/account')
      .send({ confirmation: 'DELETE', userId: 'someone-else' })
      .expect(200, { deleted: true });
    expect(service.deleteAccount).toHaveBeenCalledWith('user-1');
  });

  it('only reactivate and delete are reachable by deactivated accounts', () => {
    const proto = AccountController.prototype;
    expect(Reflect.getMetadata(ALLOW_DEACTIVATED_KEY, proto.reactivate)).toBe(true);
    expect(Reflect.getMetadata(ALLOW_DEACTIVATED_KEY, proto.deleteAccount)).toBe(true);
    expect(Reflect.getMetadata(ALLOW_DEACTIVATED_KEY, proto.deactivate)).toBeUndefined();
  });
});
