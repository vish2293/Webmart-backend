import { model, Schema, type Types } from 'mongoose';

export interface ReviewRecord {
  _id: Types.ObjectId;
  product: Types.ObjectId;
  user: Types.ObjectId;
  rating: number;
  title?: string;
  comment?: string;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<ReviewRecord>(
  {
    product: { type: Schema.Types.ObjectId, required: true, ref: 'Product' },
    user: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, trim: true, maxlength: 100 },
    comment: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);

// One review per customer per product, even when two requests race.
reviewSchema.index({ product: 1, user: 1 }, { unique: true });
reviewSchema.index({ product: 1, createdAt: -1 });

export const Review = model<ReviewRecord>('Review', reviewSchema);
