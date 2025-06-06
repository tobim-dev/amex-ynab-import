import 'dotenv/config';
import * as amex from './amex.js';
import {
  convertCSV,
  convertPendingTransactions,
  fetchTransactions,
  createTransactions,
  fetchAccounts,
  deleteTransaction,
  ynabAPI,
  budgetId,
} from './ynab.js';
import axios from 'axios';
import fs from 'fs';
import { SaveTransaction, TransactionDetail } from 'ynab';
import natural from 'natural';
import { match } from 'assert';

export const formatTransaction = (
  t: TransactionDetail | SaveTransaction
) =>
  `${t.account_id}: $${t.amount! / 1000} at ${t.payee_name} on ${
    t.date
  }`;

(async () => {
  try {
    console.log('Going to YNAB');
    const ynabAccounts = await fetchAccounts();
    const ynabTransactions = await fetchTransactions();

    console.log(
      'Going to American Express to fetch your CSV files and match to YNAB accounts by name'
    );

    const amexAccounts = await amex.fetchTransactions();
    if (amexAccounts.length == 0)
      throw new Error('Something has gone awry.');

    for (const amexAccount of amexAccounts) {
      const ynabAccount = ynabAccounts.find(
        (ynabAccount) => ynabAccount.name === amexAccount.name
      );

      if (!ynabAccount) {
        console.warn(
          `There is no YNAB account named "${amexAccount.name}". Rename appropriate YNAB account to link.`
        );
        continue;
      }

      const csvTransactions = amexAccount.transactions
        ? await convertCSV(amexAccount.transactions, ynabAccount.id)
        : [];

      const pendingTransactions = amexAccount.pendingTransactions
        ? await convertPendingTransactions(
            amexAccount.pendingTransactions,
            ynabAccount.id
          )
        : [];

      ynabAccount.queuedTransactions = [
        ...csvTransactions,
        ...pendingTransactions,
      ];
    }

    const readyAccounts = ynabAccounts.filter(
      (ynabAccount) => ynabAccount.queuedTransactions.length > 0
    );

    readyAccounts.forEach((ynabAccount) => {
      console.log(
        `${ynabAccount.name} may have some transactions imported`
      );
    });

    const unfilteredImportTransactions = readyAccounts
      .map((ynabAccount) => ynabAccount.queuedTransactions)
      .flat();

    let importTransactions: SaveTransaction[] =
      unfilteredImportTransactions.reduce(
        (transactions, parentTransaction) => {
          const voidingTransaction = transactions.find(
            (t) =>
              t.cleared === 'uncleared' &&
              t.amount === -parentTransaction.amount! &&
              t.payee_name === parentTransaction.payee_name &&
              t.date === parentTransaction.date
          );
          if (voidingTransaction) {
            console.log(
              `Transaction ${formatTransaction(
                parentTransaction
              )} has a voiding transaction, ignoring...`
            );
            transactions = transactions.filter(
              (t) =>
                t !== voidingTransaction && t !== parentTransaction
            );
          }
          return transactions;
        },
        [...unfilteredImportTransactions]
      );

    const staleTransactions: TransactionDetail[] = [];
    const pendingTransactionsThatPosted: TransactionDetail[] = [];

    const pendingExistingTransactions = ynabTransactions.filter(
      (t) =>
        t.cleared === 'uncleared' &&
        !t.deleted &&
        readyAccounts.find(
          (account) => account.name === t.account_name
        )
    );

    for (const existingPendingTransaction of pendingExistingTransactions) {
      const matchedImportTransaction = importTransactions.find(
        (t) => {
          const dateMatch =
            Math.abs(
              new Date(t.date as string).getTime() -
                new Date(
                  existingPendingTransaction.date as string
                ).getTime()
            ) <=
            86400 * 3 * 1000;

          const existingCurrentAmount =
            existingPendingTransaction.amount;

          const existingOriginalAmount =
            existingPendingTransaction.import_id
              ? parseFloat(
                  existingPendingTransaction.import_id.split(':')[1]
                )
              : existingCurrentAmount;

          const amountMatch =
            t.amount === existingCurrentAmount ||
            (!t.cleared && t.amount === existingOriginalAmount);

          const cleanImportName = (payeeName: string) =>
            payeeName.replace('Aplpay ', '').replace('Tst* ', '');

          let payeeMatch = false;

          let importPayeeName = t.payee_name;

          let existingPayeeName =
            existingPendingTransaction.import_payee_name ||
            existingPendingTransaction.payee_name;

          if (importPayeeName && existingPayeeName) {
            importPayeeName = importPayeeName.trim();

            existingPayeeName = cleanImportName(existingPayeeName);

            payeeMatch =
              importPayeeName === existingPayeeName ||
              natural.JaroWinklerDistance(
                importPayeeName,
                existingPayeeName
              ) >= 0.25;
          }

          return dateMatch && amountMatch && payeeMatch;
        }
      );
      if (
        matchedImportTransaction &&
        matchedImportTransaction.cleared === 'uncleared'
      ) {
        console.log(
          `Transaction ${formatTransaction(
            existingPendingTransaction
          )} still pending`
        );

        if (
          existingPendingTransaction.date !==
            matchedImportTransaction.date ||
          existingPendingTransaction.import_id !==
            matchedImportTransaction.import_id
        ) {
          console.log(
            `Pending transaction ${formatTransaction(
              existingPendingTransaction
            )} has changed date or import ID. Ignoring to prevent duplicate...`
          );
          importTransactions = importTransactions.filter(
            (t) => t !== matchedImportTransaction
          );
        }
        continue;
      } else if (matchedImportTransaction) {
        const bannedPayeeNameStarts = [
          'Transfer : ',
          'Starting Balance',
          'Manual Balance Adjustment',
          'Reconciliation Balance Adjustment',
        ];

        if (
          !bannedPayeeNameStarts.some((payeeNameStart) =>
            matchedImportTransaction.payee_name?.startsWith(
              payeeNameStart
            )
          )
        )
          matchedImportTransaction.payee_name =
            existingPendingTransaction.payee_name;

        matchedImportTransaction.approved =
          existingPendingTransaction.approved;
        matchedImportTransaction.category_id =
          existingPendingTransaction.category_id;
        matchedImportTransaction.memo =
          existingPendingTransaction.memo;
        matchedImportTransaction.subtransactions =
          existingPendingTransaction.subtransactions;

        if (
          ![
            'red',
            'orange',
            'yellow',
            'green',
            'blue',
            'purple',
          ].includes(matchedImportTransaction.flag_color || '')
        )
          matchedImportTransaction.flag_color = undefined;

        console.log(
          `Transaction ${formatTransaction(
            existingPendingTransaction
          )} posted. Copying over data to new transaction entry.`,
          matchedImportTransaction
        );
        pendingTransactionsThatPosted.push(
          existingPendingTransaction
        );
      } else {
        staleTransactions.push(existingPendingTransaction);
      }
    }

    for (const transaction of staleTransactions) {
      console.log(
        `Clearing out stale transaction ${formatTransaction(
          transaction
        )}`
      );
      if (
        budgetId &&
        transaction.flag_color !== 'red' &&
        transaction.subtransactions &&
        transaction.subtransactions.length > 0
      ) {
        try {
          await ynabAPI.transactions.updateTransaction(
            budgetId,
            transaction.id,
            {
              transaction: {
                flag_color: 'red',
                memo: 'Stale! Please review and remove',
              },
            }
          );
        } catch (e) {
          console.error('Unable to update stale transaction', e);
        }
      } else {
        await deleteTransaction(transaction);
      }
    }

    for (const transaction of pendingTransactionsThatPosted) {
      console.log(
        `Clearing out pending transaction that posted: ${formatTransaction(
          transaction
        )}`
      );
      await deleteTransaction(transaction);
    }

    console.log(
      `Importing ${importTransactions.length} transactions to YNAB (it will ignore duplicate imports, so actual amount may differ)`
    );

    // @ts-ignore
    await createTransactions(importTransactions);

    console.log('All done. Until next time! 👋');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
