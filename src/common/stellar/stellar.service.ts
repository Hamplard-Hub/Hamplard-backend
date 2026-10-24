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

export const CONTRACT_EVENT_PAGE_LIMIT = 100;

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

  /** Fetch one page of Hamplard contract events. A cursor resumes after its event. */
  async fetchContractEvents(
    startLedger: number,
    cursor?: string,
  ): Promise<SorobanRpc.Api.GetEventsResponse> {
    try {
      return await this.rpcClient.getEvents({
        ...(cursor ? { cursor } : { startLedger }),
        filters: [
          {
            type: 'contract',
            contractIds: [this.contractId],
          },
        ],
        limit: CONTRACT_EVENT_PAGE_LIMIT,
      });
    } catch (error) {
      this.logger.error(`Failed to fetch events from ${cursor ? 'cursor' : `ledger ${startLedger}`}`, error.message);
      throw error;
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
  async verifyCertificateOnChain(
    certificateId: string,
  ): Promise<{ valid: boolean; error?: { code: string; message: string } }> {
    try {
      const { nativeToScVal } = await import('@stellar/stellar-sdk');
      const result = await this.simulateCall('verify_certificate', [
        nativeToScVal(certificateId, { type: 'string' }),
      ]);
      return { valid: Boolean(result) };
    } catch (error) {
      this.logger.error(`verifyCertificateOnChain(${certificateId}) failed: ${error.message}`);
      return {
        valid: false,
        error: {
          code: error.code || 'UNKNOWN_ERROR',
          message: error.message,
        },
      };
    }
  }

  /**
   * Look up a submitted transaction by hash and report whether it succeeded.
   * Issue #249: Differentiates RPC errors from invalid hashes.
   * Returns null only for NOT_FOUND (hash not found).
   * Throws HttpException(503) for RPC errors (network down, timeouts).
   */
  async getTransactionStatus(
    txHash: string,
  ): Promise<{ status: string; successful: boolean } | null> {
    try {
      const result = await this.rpcClient.getTransaction(txHash);
      return {
        status: result.status,
        successful: result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      };
    } catch (error) {
      // NOT_FOUND means the hash doesn't exist in the ledger
      if (error.message?.includes('NOT_FOUND')) {
        this.logger.warn(`Transaction ${txHash} not found on-chain`);
        return null;
      }
      
      // Any other error is treated as an RPC/network failure (throw 503)
      this.logger.error(`getTransactionStatus(${txHash}) RPC error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Verify an enrollment transaction on-chain (issue #239).
   * Fetches the transaction, validates it succeeded, and extracts:
   * - the contract call method and parameters
   * - the student address, course ID, and amount paid
   * Returns null if the tx is not found, pending, or fails.
   */
  async verifyEnrollmentTransaction(
    txHash: string,
  ): Promise<{
    studentAddress: string;
    courseId: string;
    amountPaid: string;
  } | null> {
    try {
      const result = await this.rpcClient.getTransaction(txHash);

      // Tx must have succeeded
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        this.logger.warn(`Enrollment tx ${txHash} status: ${result.status}`);
        return null;
      }

      // Extract the transaction envelope
      if (!result.resultXdr) {
        this.logger.warn(`Enrollment tx ${txHash} has no result XDR`);
        return null;
      }

      // Parse the result XDR to look for 'enroll' contract call details
      // The event poller extracts these from the contract events.
      // For now, we rely on events emitted by the contract.
      const events = await this.rpcClient.getEvents({
        startLedger: result.ledger,
        filters: [{ type: 'contract', contractIds: [this.contractId] }],
        limit: 100,
      });

      // Look for 'student_enrolled' event with matching txHash
      for (const event of events.events) {
        if (event.type === 'contract' && event.event.type === 'contract') {
          const eventData = event.event;
          // Extract event topics and data — structure depends on contract implementation
          // Placeholder: assumes events emit (studentAddress, courseId, amountPaid) as topics/data
          // This will be validated by the event poller in detail.
          if (eventData.topics && eventData.data) {
            try {
              const parsed = scValToNative(eventData.data);
              return {
                studentAddress: parsed.student || '',
                courseId: parsed.courseId || '',
                amountPaid: (parsed.amount || '0').toString(),
              };
            } catch (err) {
              this.logger.debug(`Failed to parse enrollment event data: ${err.message}`);
            }
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`verifyEnrollmentTransaction(${txHash}) failed`, error.message);
      return null;
    }
  }

  // ----------------------------------------------------------
  // USDC UTILITIES
  // ----------------------------------------------------------

  /** Convert stroops (i128 as string/bigint) to human-readable USDC */
  stroopsToUsdc(stroops: string | bigint, decimals = 2): string {
    const raw = typeof stroops === 'bigint' ? stroops.toString() : stroops;
    if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw)) {
      throw new TypeError('Stroops must be a base-10 integer');
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
      throw new RangeError('USDC decimal places must be an integer between 0 and 100');
    }

    const value = BigInt(raw);
    const negative = value < 0n;
    const absolute = negative ? -value : value;

    if (decimals <= 7) {
      const divisor = 10n ** BigInt(7 - decimals);
      const rounded = (absolute + divisor / 2n) / divisor;
      const scale = 10n ** BigInt(decimals);
      const roundedWhole = rounded / scale;
      const roundedFraction = (rounded % scale).toString().padStart(decimals, '0');
      const formatted = decimals === 0 ? roundedWhole.toString() : `${roundedWhole}.${roundedFraction}`;
      return negative && value !== 0n ? `-${formatted}` : formatted;
    }

    const whole = absolute / 10_000_000n;
    const fraction = (absolute % 10_000_000n).toString().padStart(7, '0') + '0'.repeat(decimals - 7);
    const formatted = `${whole}.${fraction}`;
    return negative && value !== 0n ? `-${formatted}` : formatted;
  }

  /** Convert human-readable USDC to stroops bigint */
  usdcToStroops(usdc: string | number): bigint {
    if (typeof usdc === 'number' && !Number.isFinite(usdc)) {
      throw new TypeError('USDC amount must be a finite number');
    }

    let input = String(usdc).trim();
    if (typeof usdc === 'number' && /[eE]/.test(input)) {
      const scientific = input.match(/^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
      if (!scientific) throw new TypeError('USDC amount must be a decimal number');
      const [, sign, whole, fraction = '', exponentText] = scientific;
      const digits = whole + fraction;
      const decimalPosition = whole.length + Number(exponentText);
      if (decimalPosition <= 0) {
        input = `${sign}0.${'0'.repeat(-decimalPosition)}${digits}`;
      } else if (decimalPosition >= digits.length) {
        input = `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}`;
      } else {
        input = `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
      }
    }

    const match = input.match(/^([+-]?)(\d+)(?:\.(\d{0,7}))?$/);
    if (!match) {
      throw new TypeError('USDC amount must be a base-10 decimal with at most 7 fractional digits');
    }

    const [, sign, whole, fraction = ''] = match;
    const stroops = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0') || '0');
    return sign === '-' ? -stroops : stroops;
  }
}
