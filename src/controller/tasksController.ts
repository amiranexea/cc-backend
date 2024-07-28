import { Request, Response } from 'express';
import { Entity, PrismaClient } from '@prisma/client';
import { uploadAgreementForm } from 'src/config/cloudStorage.config';
import { Title, saveNotification } from './notificationController';
import { clients, io } from 'src/server';

const prisma = new PrismaClient();

export const creatorUploadAgreement = async (req: Request, res: Response) => {
  const userid = req.session.userid;
  const { campaignId, timelineId } = JSON.parse(req.body.data);

  try {
    if (req.files && (req.files as any).agreementForm) {
      const campaign = await prisma.campaign.findUnique({
        where: {
          id: campaignId,
        },
        include: {
          campaignAdmin: true,
        },
      });

      const user = await prisma.user.findUnique({
        where: {
          id: userid as string,
        },
      });

      const agreementForm = (req.files as any).agreementForm;
      const [url] = await Promise.all([
        uploadAgreementForm(agreementForm.tempFilePath, agreementForm.name, 'creatorAgreement'),
      ]);

      await prisma.submission.create({
        data: {
          creatorId: user?.id as string,
          campaignId: campaign?.id as string,
          type: 'AGREEMENT_FORM',
          content: url as string,
          campaignTaskId: timelineId as string,
        },
      });

      await prisma.campaignTask.update({
        where: {
          id: timelineId,
        },
        data: {
          status: 'PENDING_REVIEW',
        },
      });

      const data = await saveNotification(
        userid as string,
        Title.Create,
        `Agreement Form for Campaign ${campaign?.name} is submitted.`,
        Entity.Campaign,
      );

      await Promise.all([
        campaign?.campaignAdmin.map(async (item) => {
          const data = await saveNotification(
            item.adminId,
            Title.Create,
            `New Agreement Submitted By ${user?.name} For Campaign ${campaign?.name}`,
            Entity.Campaign,
          );
          io.to(clients.get(item.adminId)).emit('notification', data);
        }),
      ]);

      io.to(clients.get(userid)).emit('notification', data);
      return res.status(200).json({ message: 'Successfully upload' });
    } else {
      return res.status(404).json({ message: 'File not found' });
    }
  } catch (error) {
    console.log(error);
    return res.status(400).json(error);
  }
};

export const getSubmissionByCampaignCreatorId = async (req: Request, res: Response) => {
  const { creatorId, campaignId } = req.query;

  try {
    const campaignTask = await prisma.campaignTask.findMany({
      where: {
        AND: [
          {
            userId: creatorId as string,
          },
          {
            campaignId: campaignId as string,
          },
        ],
      },
      include: {
        submission: true,
      },
    });

    const data = await Promise.all(
      campaignTask.map(async (value) => {
        const result = await prisma.submission.findUnique({
          where: {
            campaignTaskId: value.id,
          },
          include: {
            campaignTask: {
              select: {
                status: true,
                id: true,
              },
            },
            firstDraft: true,
            finalDraft: true,
            feedback: true,
          },
        });
        return result;
      }),
    );

    return res.status(200).json(data);
  } catch (error) {
    return res.status(400).json(error);
  }
};

export const adminManageAgreementSubmission = async (req: Request, res: Response) => {
  const data = req.body;

  try {
    const campaign = await prisma.campaign.findUnique({
      where: {
        id: data?.campaignId,
      },
    });

    if (data.status === 'approve') {
      const { campaignTaskId, firstDraftId, userId } = data;
      await prisma.campaignTask.update({
        where: {
          id: campaignTaskId,
        },
        data: {
          status: 'COMPLETED',
        },
      });
      await prisma.campaignTask.update({
        where: {
          id: firstDraftId,
        },
        data: {
          status: 'IN_PROGRESS',
        },
      });
      const notification = await saveNotification(
        userId,
        Title.Create,
        `First Draft is open for submission`,
        Entity.Campaign,
      );
      io.to(clients.get(userId)).emit('notification', notification);
    } else if (data.status === 'reject') {
      const { feedback, campaignTaskId, submissionId, userId } = data;
      await prisma.campaignTask.update({
        where: {
          id: campaignTaskId,
        },
        data: {
          status: 'CHANGES_REQUIRED',
        },
      });
      await prisma.feedback.create({
        data: {
          content: feedback,
          submissionId: submissionId,
          adminId: req.session.userid as string,
        },
      });
      const notification = await saveNotification(
        userId,
        Title.Create,
        `Please Resubmit Your Agreement Form for ${campaign?.name}`,
        Entity.Campaign,
      );
      io.to(clients.get(userId)).emit('notification', notification);
    }

    return res.status(200).json({ message: 'Successfully updated' });
  } catch (error) {
    console.log(error);
    return res.status(400).json(error);
  }
};
