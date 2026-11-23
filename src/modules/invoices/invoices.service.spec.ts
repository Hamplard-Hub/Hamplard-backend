import { NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { InvoicesService } from './invoices.service';

/** Issue #313 — students list/download their own invoices; admins may download any. */
describe('InvoicesService (list + download)', () => {
  let service: InvoicesService;

  const prisma = {
    $transaction: jest.fn(),
    invoice: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const OWNER = { id: 'student-1', role: UserRole.STUDENT };
  const OTHER_STUDENT = { id: 'student-2', role: UserRole.STUDENT };
  const ADMIN = { id: 'admin-1', role: UserRole.ADMIN };

  const invoiceRow = {
    id: 'inv-1',
    invoiceNumber: 42,
    studentId: 'student-1',
    amount: '25.5',
    txHash: 'abc123',
    issuedAt: new Date('2026-01-15T10:00:00Z'),
    course: { title: 'Welding Basics' },
    student: { name: 'Ada', stellarAddress: 'GABC', email: 'ada@example.com' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    // Only the PDF/list paths are exercised, so stellar + notifications are unused.
    service = new InvoicesService(prisma as any, {} as any, {} as any);
  });

  describe('findMine', () => {
    it('scopes the query to the given student and paginates newest first', async () => {
      prisma.invoice.findMany.mockResolvedValue([{ id: 'inv-1' }]);
      prisma.invoice.count.mockResolvedValue(45);

      const result = await service.findMine('student-1', 2, 20);

      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentId: 'student-1' },
          orderBy: { issuedAt: 'desc' },
          skip: 20,
          take: 20,
        }),
      );
      expect(prisma.invoice.count).toHaveBeenCalledWith({ where: { studentId: 'student-1' } });
      expect(result).toEqual({
        data: [{ id: 'inv-1' }],
        meta: { total: 45, page: 2, limit: 20, totalPages: 3 },
      });
    });

    it('defaults to page 1, limit 20 and returns an empty page when there are no invoices', async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      const result = await service.findMine('student-1');

      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 20, totalPages: 0 });
    });

    it('selects only invoice fields (no student PII or internals)', async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      await service.findMine('student-1');

      const args = prisma.invoice.findMany.mock.calls[0][0];
      expect(args.select).toBeDefined();
      expect(args.include).toBeUndefined();
      expect(args.select.student).toBeUndefined();
    });
  });

  describe('getPdfForDownload', () => {
    it('renders a PDF on demand for the invoice owner', async () => {
      prisma.invoice.findUnique.mockResolvedValue(invoiceRow);

      const { buffer, filename } = await service.getPdfForDownload('inv-1', OWNER);

      expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
      expect(filename).toBe('invoice-42.pdf');
      expect(prisma.invoice.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'inv-1' } }),
      );
    });

    it('lets an admin download any student\'s invoice', async () => {
      prisma.invoice.findUnique.mockResolvedValue(invoiceRow);

      const { buffer } = await service.getPdfForDownload('inv-1', ADMIN);

      expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    });

    it('returns 404 (not 403) when a different student asks, so existence is not leaked', async () => {
      prisma.invoice.findUnique.mockResolvedValue(invoiceRow);

      await expect(service.getPdfForDownload('inv-1', OTHER_STUDENT)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the same 404 when the invoice does not exist', async () => {
      prisma.invoice.findUnique.mockResolvedValue(null);

      await expect(service.getPdfForDownload('missing', OWNER)).rejects.toThrow(
        new NotFoundException('Invoice not found'),
      );
    });

    it('falls back to the wallet address, then email, when the student has no name', async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        ...invoiceRow,
        student: { name: null, stellarAddress: null, email: 'ada@example.com' },
      });

      await expect(service.getPdfForDownload('inv-1', OWNER)).resolves.toBeDefined();
    });
  });
});
