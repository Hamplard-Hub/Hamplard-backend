import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Networks,
  SorobanRpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

/**
 * StellarService
 *
 * Provides:
 *  - Soroban RPC client for querying the Stellar network
 *  - Contract event fetching (EventsService poller)
 *  - Read-only contract simulation (is_enrolled, verify_certificate, etc.)
 *  - USDC / stroops conversion helpers
 *
 * This service does NOT submit write transactions — all writes are signed
 * by the user's Freighter wallet in the frontend. The admin wallet address
 * (for course approval, mark_completed, issue_certificate) is managed
 * by a separate secure signing service in production.
 */
@Injectable()
export class StellarService implements OnModuleInit {
  private readonly logger = new Logger(StellarService.name);

  private rpcClient: SorobanRpc.Server;
  private networkPassphrase: string;
  private contractId: string;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const rpcUrl     = this.config.get<string>('STELLAR_RPC_URL');
    const networkName = this.config.get<string>('STELLAR_NETWORK', 'testnet');

    this.rpcClient = new SorobanRpc.Server(rpcUrl, { allowHttp: true });
    this.contractId = this.config.get<string>('HAMPLARD_CONTRACT_ID');
    this.networkPassphrase =
      networkName === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

    this.logger.log(`Stellar connected to ${networkName} (${rpcUrl})`);
    this.logger.log(`Hamplard contract: ${this.contractId}`);
  }

  // ----------------------------------------------------------
  // RPC ACCESS
  // ----------------------------------------------------------

  getClient(): SorobanRpc.Server      { return this.rpcClient; }
  getNetworkPassphrase(): string       { return this.networkPassphrase; }
  getContractId(): string              { return this.contractId; }

  async getLatestLedger(): Promise<number> {
    const info = await this.rpcClient.getLatestLedger();
    return info.sequence;
  }

  // ----------------------------------------------------------
  // EVENT FETCHING
  // ----------------------------------------------------------

  /**
   * Fetch Hamplard contract events from a given ledger.
   * Called every 5 seconds by EventsService.
   */
  async fetchContractEvents(
    startLedger: number,
  ): Promise<SorobanRpc.Api.EventResponse[]> {
    try {
      const result = await this.rpcClient.getEvents({
        startLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [this.contractId],
          },
        ],
        limit: 100,
      });
      return result.events ?? [];
    } catch (error) {
      this.logger.error(`Failed to fetch events from ledger ${startLedger}`, error.message);
      return [];
    }
  }

  // ----------------------------------------------------------
  // READ-ONLY CONTRACT CALLS
  // ----------------------------------------------------------

  /**
   * Simulate a read-only contract call — no gas, no signing.
   * Used to check on-chain state (is_enrolled, verify_certificate).
   */
  async simulateCall(method: string, args: xdr.ScVal[]): Promise<any> {
    try {
      const contract    = new Contract(this.contractId);
      const dummyKeypair = Keypair.random();
      const dummyAccount = {
        accountId: () => dummyKeypair.publicKey(),
        sequenceNumber: () => '0',
        incrementSequenceNumber: () => {},
      } as any;

      const tx = new TransactionBuilder(dummyAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

      const simulation = await this.rpcClient.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation error: ${simulation.error}`);
      }
      if (SorobanRpc.Api.isSimulationSuccess(simulation) && simulation.result) {
        return scValToNative(simulation.result.retval);
      }
      return null;
    } catch (error) {
      this.logger.error(`simulateCall(${method}) failed`, error.message);
      throw error;
    }
  }

  /** Check on-chain whether a student is enrolled in a course */
  async isEnrolledOnChain(studentAddress: string, courseId: string): Promise<boolean> {
    try {
      const { nativeToScVal, Address } = await import('@stellar/stellar-sdk');
      const result = await this.simulateCall('is_enrolled', [
        new Address(studentAddress).toScVal(),
        nativeToScVal(courseId, { type: 'string' }),
      ]);
      return Boolean(result);
    } catch { return false; }
  }

  /** Verify a certificate on-chain */
  async verifyCertificateOnChain(certificateId: string): Promise<boolean> {
    try {
      const { nativeToScVal } = await import('@stellar/stellar-sdk');
      const result = await this.simulateCall('verify_certificate', [
        nativeToScVal(certificateId, { type: 'string' }),
      ]);
      return Boolean(result);
    } catch { return false; }
  }

  // ----------------------------------------------------------
  // USDC UTILITIES
  // ----------------------------------------------------------

  /** Convert stroops (i128 as string/bigint) to human-readable USDC */
  stroopsToUsdc(stroops: string | bigint, decimals = 2): string {
    const v = BigInt(stroops);
    const whole    = v / 10_000_000n;
    const fraction = (v % 10_000_000n).toString().padStart(7, '0');
    return parseFloat(`${whole}.${fraction}`).toFixed(decimals);
  }

  /** Convert human-readable USDC to stroops bigint */
  usdcToStroops(usdc: string | number): bigint {
    const [whole, fraction = ''] = String(usdc).split('.');
    const padded = fraction.padEnd(7, '0').slice(0, 7);
    return BigInt(whole) * 10_000_000n + BigInt(padded);
  }
}
